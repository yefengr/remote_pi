"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Activity, Check, Circle, Link2, MessageSquare, Pencil, Plus, Radio, RefreshCw, Settings, Trash2, WifiOff, X } from "lucide-react";
import { PairingDialog, StartupErrorView, StartupLoading, type StartupError } from "@/components/pwa/pwa-startup";
import { createPairRequest, parsePairUri, relayMismatch } from "@/lib/remote-pi/pairing";
import { PeerChannel } from "@/lib/remote-pi/peer-channel";
import { RelayClient } from "@/lib/remote-pi/relay-client";
import { decodeBase64, encodeBase64, normalizePeerId } from "@/lib/remote-pi/encoding";
import { generateOwnerKeyPair } from "@/lib/remote-pi/crypto";
import type { OwnerKeyPair, ServerMessage, SessionHistoryEvent } from "@/lib/remote-pi/types";
import {
  clearPwaData,
  getPwaDatabase,
  listPwaMessages,
  listPwaPeers,
  listPwaRooms,
  type PwaMessageRecord,
  type PwaPeerRecord,
  type PwaRoomRecord,
} from "@/lib/pwa/db";

const DEFAULT_RELAY = "https://relay-rp1.jacobmoura.work";
const ACTIVE_PEER_SETTING = "active_peer";
const RELAY_SETTING = "relay_url";
const ACTIVE_ROOM_SETTING = "active_room:";

type ConnectionViewState = "offline" | "connecting" | "online" | "retrying";

type PairState = "idle" | "scanning" | "pairing";
type StartupState = "loading" | "ready" | "error";


function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function browserName(): string {
  if (typeof navigator === "undefined") return "Browser";
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return "iPhone browser";
  if (/Android/i.test(navigator.userAgent)) return "Android browser";
  return "Browser";
}

function displayPeer(peer: PwaPeerRecord): string {
  return peer.nickname?.trim() || peer.sessionName || "Remote Pi";
}

function toStoredKey(key: Uint8Array): string {
  return encodeBase64(key, "url");
}

function fromStoredKey(value: string): Uint8Array {
  return decodeBase64(value, "url");
}

function assertBrowserCapabilities(): void {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new Error("secure_context_required");
  }
  if (typeof globalThis.crypto?.getRandomValues !== "function" || !globalThis.crypto.subtle) {
    throw new Error("web_crypto_unavailable");
  }
  if (typeof indexedDB === "undefined") {
    throw new Error("indexeddb_unavailable");
  }
}

export function PwaApp() {
  const [identity, setIdentity] = useState<OwnerKeyPair | null>(null);
  const [peers, setPeers] = useState<PwaPeerRecord[]>([]);
  const [rooms, setRooms] = useState<PwaRoomRecord[]>([]);
  const [activePeerId, setActivePeerId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState("main");
  const [messages, setMessages] = useState<PwaMessageRecord[]>([]);
  const [connection, setConnection] = useState<ConnectionViewState>("offline");
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);
  const [draft, setDraft] = useState("");
  const [pairState, setPairState] = useState<PairState>("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startupState, setStartupState] = useState<StartupState>("loading");
  const [startupError, setStartupError] = useState<StartupError | null>(null);
  const channelRef = useRef<PeerChannel | null>(null);
  const relayRef = useRef<RelayClient | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const messagesRef = useRef(messages);
  const roomsRef = useRef(rooms);
  const roomIdRef = useRef(roomId);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  const activePeer = useMemo(
    () => peers.find((peer) => peer.remoteEpk === activePeerId) ?? null,
    [activePeerId, peers],
  );
  const activeRooms = useMemo(
    () => rooms.filter((room) => room.peerEpk === activePeerId).sort((a, b) => (a.name || a.cwd || a.roomId).localeCompare(b.name || b.cwd || b.roomId)),
    [activePeerId, rooms],
  );

  const persistMessage = useCallback(async (message: PwaMessageRecord) => {
    await getPwaDatabase().messages.put(message);
  }, []);

  const addOrUpdateMessage = useCallback(
    (next: PwaMessageRecord) => {
      const current = messagesRef.current;
      const index = current.findIndex((message) => message.id === next.id);
      const updated = index < 0
        ? [...current, next].sort((a, b) => a.createdAt - b.createdAt)
        : current.map((message, messageIndex) => messageIndex === index ? { ...message, ...next } : message);
      messagesRef.current = updated;
      setMessages(updated);
      if (next.status !== "streaming") void persistMessage(index < 0 ? next : updated[index]);
    },
    [persistMessage],
  );
  const upsertRooms = useCallback(async (peerEpk: string, nextRooms: PwaRoomRecord[]) => {
    await getPwaDatabase().rooms.bulkPut(nextRooms);
    const updated = [...roomsRef.current.filter((room) => room.peerEpk !== peerEpk), ...nextRooms];
    roomsRef.current = updated;
    setRooms(updated);
  }, []);

  const handleControlFrame = useCallback((frame: import("@/lib/remote-pi/types").ControlFrame) => {
    if (frame.type === "presence") return;
    if (!activePeerId) return;
    let framePeer: string;
    try {
      framePeer = normalizePeerId(frame.peer);
    } catch {
      return;
    }
    if (framePeer !== activePeerId) return;
    if (frame.type === "rooms") {
      const now = Date.now();
      void upsertRooms(framePeer, frame.rooms.map((room) => ({
        id: `${framePeer}:${room.room_id}`,
        peerEpk: framePeer,
        roomId: room.room_id,
        name: room.name ?? undefined,
        cwd: room.cwd ?? undefined,
        startedAt: room.started_at,
        model: room.model ?? undefined,
        thinking: room.thinking ?? undefined,
        working: room.working,
        online: true,
        updatedAt: now,
      })));
      return;
    }
    if (frame.type === "room_announced" || frame.type === "room_meta_updated") {
      const previous = roomsRef.current.find((room) => room.peerEpk === framePeer && room.roomId === frame.room_id);
      const next: PwaRoomRecord = {
        id: `${framePeer}:${frame.room_id}`,
        peerEpk: framePeer,
        roomId: frame.room_id,
        name: frame.type === "room_announced" ? frame.name ?? undefined : previous?.name,
        cwd: frame.type === "room_announced" ? frame.cwd ?? undefined : previous?.cwd,
        startedAt: frame.type === "room_announced" ? frame.started_at : previous?.startedAt,
        model: frame.type === "room_announced" ? frame.model ?? undefined : frame.meta?.model ?? previous?.model,
        thinking: frame.type === "room_announced" ? frame.thinking ?? undefined : frame.meta?.thinking ?? previous?.thinking,
        working: frame.type === "room_announced" ? frame.working : frame.meta?.working ?? previous?.working,
        online: true,
        updatedAt: Date.now(),
      };
      void upsertRooms(framePeer, [...roomsRef.current.filter((room) => !(room.peerEpk === framePeer && room.roomId === frame.room_id)), next]);
      return;
    }
    if (frame.type === "room_ended") {
      const nextRooms = roomsRef.current.filter((room) => room.peerEpk === framePeer).map((room) => room.roomId === frame.room_id ? { ...room, online: false, updatedAt: Date.now() } : room);
      void upsertRooms(framePeer, nextRooms);
    }
  }, [activePeerId, upsertRooms]);

  const applySessionHistory = useCallback(async (peerEpk: string, selectedRoom: string, events: SessionHistoryEvent[]) => {
    const records: PwaMessageRecord[] = [];
    for (const event of events) {
      if (event.type === "user_input") records.push({ id: event.id, peerEpk, roomId: selectedRoom, kind: "user", text: event.text, createdAt: event.ts, status: "complete" });
      if (event.type === "agent_message") records.push({ id: `assistant-${event.in_reply_to}`, peerEpk, roomId: selectedRoom, kind: "assistant", text: event.text, createdAt: event.ts, replyTo: event.in_reply_to, status: "complete" });
      if (event.type === "compaction") records.push({ id: `compaction-${event.ts}`, peerEpk, roomId: selectedRoom, kind: "system", text: `Context compacted: ${event.summary}`, createdAt: event.ts, status: "complete" });
    }
    const database = getPwaDatabase();
    await database.messages.where("[peerEpk+roomId]").equals([peerEpk, selectedRoom]).delete();
    if (records.length) await database.messages.bulkPut(records);
    messagesRef.current = records;
    setMessages(records);
  }, []);

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      if (!activePeerId) return;
      const now = Date.now();
      if (message.type === "agent_chunk") {
        const existing = messagesRef.current.find((item) => item.replyTo === message.in_reply_to && item.kind === "assistant");
        addOrUpdateMessage({
          id: existing?.id ?? `assistant-${message.in_reply_to}`,
          peerEpk: activePeerId,
          roomId: roomIdRef.current,
          kind: "assistant",
          text: `${existing?.text ?? ""}${message.delta}`,
          createdAt: existing?.createdAt ?? now,
          replyTo: message.in_reply_to,
          status: "streaming",
        });
      } else if (message.type === "agent_done") {
        const existing = messagesRef.current.find((item) => item.replyTo === message.in_reply_to && item.kind === "assistant");
        if (existing) addOrUpdateMessage({ ...existing, status: "complete" });
      } else if (message.type === "agent_message") {
        const existing = messagesRef.current.find((item) => item.replyTo === message.in_reply_to && item.kind === "assistant");
        addOrUpdateMessage({
          id: existing?.id ?? `assistant-${message.in_reply_to}`,
          peerEpk: activePeerId,
          roomId: roomIdRef.current,
          kind: "assistant",
          text: message.text,
          createdAt: existing?.createdAt ?? now,
          replyTo: message.in_reply_to,
          status: "complete",
        });
      } else if (message.type === "user_input" || message.type === "user_message") {
        if (!messagesRef.current.some((item) => item.id === message.id)) {
          addOrUpdateMessage({
            id: message.id,
            peerEpk: activePeerId,
            roomId: roomIdRef.current,
            kind: "user",
            text: message.text,
            createdAt: now,
            status: "complete",
          });
        }
      } else if (message.type === "session_history") {
        void applySessionHistory(activePeerId, roomIdRef.current, message.events);
      } else if (message.type === "error") {
        addOrUpdateMessage({ id: `error-${message.in_reply_to ?? id()}-${now}`, peerEpk: activePeerId, roomId: roomIdRef.current, kind: "system", text: message.message, createdAt: now, status: "error" });
      }
    },
    [activePeerId, addOrUpdateMessage, applySessionHistory],
  );

  const connectActivePeer = useCallback(async () => {
    if (!identity || !activePeer) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setConnection("offline");
      return;
    }
    channelRef.current?.close();
    relayRef.current?.close();
    const relay = new RelayClient({ relayUrl: activePeer.relayUrl || relayUrl, identity });
    const channel = new PeerChannel({
      relay,
      remotePeer: activePeer.remoteEpk,
      roomId: activePeer.roomId || "main",
      onMessage: handleServerMessage,
      onMalformed: (reason) => setError(reason),
    });
    relayRef.current = relay;
    channelRef.current = channel;
    setConnection("connecting");
    const removeState = relay.on("state", (state) => {
      if (state === "open") setConnection("online");
      if (state === "connecting" || state === "authenticating") setConnection("connecting");
      if (state === "closed") setConnection("offline");
    });
    const removeError = relay.on("error", (eventError) => setError(eventError.message));
    const removeControl = relay.on("control", handleControlFrame);
    try {
      await relay.connect();
      retryAttemptRef.current = 0;
      relay.subscribeRooms([activePeer.remoteEpk]);
      relay.checkRooms();
      channel.send({ type: "session_sync", id: id(), limit: 200 });
    } catch (connectError) {
      setConnection("retrying");
      setError(connectError instanceof Error ? connectError.message : "Relay connection failed");
    }
    return () => {
      removeState();
      removeError();
      removeControl();
      channel.close();
      relay.close();
    };
  }, [activePeer, handleControlFrame, handleServerMessage, identity, relayUrl]);

  useEffect(() => {
    let cancelled = false;
    const startup = (async () => {
      assertBrowserCapabilities();
      const database = getPwaDatabase();
      const storedIdentity = await database.identities.get("owner");
      const nextIdentity = storedIdentity
        ? { privateKey: fromStoredKey(storedIdentity.secretKey), publicKey: fromStoredKey(storedIdentity.publicKey) }
        : await generateOwnerKeyPair();
      if (!storedIdentity) {
        await database.identities.put({ id: "owner", publicKey: toStoredKey(nextIdentity.publicKey), secretKey: toStoredKey(nextIdentity.privateKey), createdAt: Date.now() });
      }
      const [storedPeers, storedRelay, storedActive] = await Promise.all([
        listPwaPeers(),
        database.settings.get(RELAY_SETTING),
        database.settings.get(ACTIVE_PEER_SETTING),
      ]);
      if (cancelled) return;
      setIdentity(nextIdentity);
      const normalizedPeers = storedPeers.map((peer) => ({ ...peer, remoteEpk: normalizePeerId(peer.remoteEpk) }));
      if (normalizedPeers.some((peer, index) => peer.remoteEpk !== storedPeers[index]?.remoteEpk)) {
        await database.peers.bulkPut(normalizedPeers);
      }
      setPeers(normalizedPeers);
      setRelayUrl(storedRelay?.value || DEFAULT_RELAY);
      setActivePeerId(storedActive?.value ? normalizePeerId(storedActive.value) : normalizedPeers[0]?.remoteEpk || null);
    })();
    void Promise.race([
      startup,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("startup_timeout")), 10000)),
    ]).then(() => {
      if (!cancelled) setStartupState("ready");
    }).catch((startupFailure: unknown) => {
      if (cancelled) return;
      setStartupError(describeStartupFailure(startupFailure));
      setStartupState("error");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activePeerId) {
      void Promise.resolve().then(() => {
        setMessages([]);
        setRoomId("main");
      });
      return;
    }
    const selectedRoom = peers.find((peer) => peer.remoteEpk === activePeerId)?.roomId || "main";
    void listPwaRooms(activePeerId).then((storedRooms) => {
      roomsRef.current = storedRooms;
      setRooms(storedRooms);
    }).catch(() => setError("Could not read local rooms."));
    void getPwaDatabase().settings.get(`${ACTIVE_ROOM_SETTING}${activePeerId}`).then((storedRoom) => {
      const nextRoom = storedRoom?.value || selectedRoom;
      setRoomId(nextRoom);
      roomIdRef.current = nextRoom;
      return listPwaMessages(activePeerId, nextRoom);
    }).then((storedMessages) => {
      messagesRef.current = storedMessages;
      setMessages(storedMessages);
    }).catch(() => setError("Could not read local history."));
    void getPwaDatabase().settings.put({ key: ACTIVE_PEER_SETTING, value: activePeerId });
  }, [activePeerId, peers]);

  useEffect(() => {
    if (startupState !== "ready" || !activePeer || !identity) return;
    let cleanup: (() => void) | undefined;
    queueMicrotask(() => {
      void connectActivePeer().then((dispose) => {
        cleanup = dispose;
      });
    });
    return () => cleanup?.();
  }, [activePeer, connectActivePeer, identity, startupState]);

  useEffect(() => {
    const reconnect = () => {
      if (!navigator.onLine || !activePeerId) return;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      const delay = [1000, 2000, 5000, 10000, 30000][Math.min(retryAttemptRef.current, 4)];
      retryAttemptRef.current += 1;
      setConnection("retrying");
      reconnectRef.current = setTimeout(() => void connectActivePeer(), delay);
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("pageshow", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("pageshow", reconnect);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [activePeerId, connectActivePeer]);

  const selectPeer = useCallback((remoteEpk: string) => {
    setError(null);
    setActivePeerId(remoteEpk);
  }, []);

  const sendMessage = useCallback(() => {
    const text = draft.trim();
    const peer = activePeer;
    const channel = channelRef.current;
    if (!text || !peer || !channel || connection !== "online") return;
    const messageId = id();
    if (!channel.send({ type: "user_message", id: messageId, text })) {
      setError("Relay is not connected.");
      return;
    }
    addOrUpdateMessage({ id: messageId, peerEpk: peer.remoteEpk, roomId: roomIdRef.current, kind: "user", text, createdAt: Date.now(), status: "complete" });
    setDraft("");
  }, [activePeer, addOrUpdateMessage, connection, draft]);
  const pairFromQr = useCallback(
    async (raw: string) => {
      if (!identity) return;
      setPairState("pairing");
      setError(null);
      const payload = parsePairUri(raw);
      if (!payload) {
        setError("That is not a valid Remote Pi pairing QR.");
        setPairState("scanning");
        return;
      }
      if (relayMismatch(payload.relayUrl, relayUrl)) {
        setError("This QR belongs to a different Relay. Update the Relay setting first.");
        setPairState("scanning");
        return;
      }
      const remotePeer = normalizePeerId(payload.epk);
      const relay = new RelayClient({ relayUrl: payload.relayUrl || relayUrl, identity });
      let closePairing = () => {};
      const pairedPeer = await new Promise<PwaPeerRecord | null>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (value: PwaPeerRecord | null) => {
          if (!timer) return;
          clearTimeout(timer);
          timer = null;
          resolve(value);
        };
        timer = setTimeout(() => {
          setError("Pairing timed out. Generate a fresh QR on the Pi.");
          finish(null);
        }, 15000);
        const channel = new PeerChannel({
          relay,
          remotePeer,
          roomId: payload.roomId || "main",
          onPairOk: (ok) => {
            finish({ remoteEpk: remotePeer, sessionName: ok.session_name, relayUrl: payload.relayUrl || relayUrl, pairedAt: new Date().toISOString(), roomId: ok.room_id || payload.roomId || "main" });
          },
          onPairError: (pairError) => {
            setError(pairError.message || pairError.code);
            finish(null);
          },
          onMalformed: (reason) => {
            setError(reason);
            finish(null);
          },
        });
        closePairing = () => channel.close();
        void relay.connect().then(() => {
          channel.sendPairRequest(createPairRequest(payload.token, browserName(), id()));
        }).catch((connectError) => {
          setError(connectError instanceof Error ? connectError.message : "Could not connect to Relay.");
          finish(null);
        });
      });
      closePairing();
      relay.close();
      if (pairedPeer) {
        await getPwaDatabase().peers.put(pairedPeer);
        setPeers(await listPwaPeers());
        setActivePeerId(pairedPeer.remoteEpk);
        setPairState("idle");
      } else {
        setPairState("scanning");
      }
    },
    [identity, relayUrl],
  );

  const saveRelayUrl = useCallback(async (value: string) => {
    const normalized = value.trim().replace(/\/$/, "");
    setRelayUrl(normalized || DEFAULT_RELAY);
    await getPwaDatabase().settings.put({ key: RELAY_SETTING, value: normalized || DEFAULT_RELAY });
    setSettingsOpen(false);
  }, []);

  const removePeer = useCallback(async (remoteEpk: string) => {
    await getPwaDatabase().peers.delete(remoteEpk);
    const nextPeers = await listPwaPeers();
    setPeers(nextPeers);
    setActivePeerId((current) => (current === remoteEpk ? nextPeers[0]?.remoteEpk || null : current));
  }, []);

  const renamePeer = useCallback(async (peer: PwaPeerRecord) => {
    const nickname = window.prompt("Name this Pi", peer.nickname || peer.sessionName)?.trim();
    if (!nickname) return;
    const updated = { ...peer, nickname };
    await getPwaDatabase().peers.put(updated);
    setPeers(await listPwaPeers());
  }, []);

  const clearLocalData = useCallback(async () => {
    if (!window.confirm("Clear this browser's Remote Pi identity, pairings, and history?")) return;
    channelRef.current?.close();
    relayRef.current?.close();
    await clearPwaData();
    window.location.reload();
  }, []);

  if (startupState === "loading") return <StartupLoading />;
  if (startupState === "error") return <StartupErrorView error={startupError} onRetry={() => window.location.reload()} />;

  return (
    <div className="pwa-root">
      <header className="pwa-topbar">
        <div className="pwa-brand"><span className="pwa-brand-mark">π</span><span>Remote Pi</span><span className="pwa-brand-tag">BROWSER APP</span></div>
        <div className="pwa-topbar-actions">
          <ConnectionStatus state={connection} />
          <button className="pwa-icon-button" type="button" onClick={() => setSettingsOpen((open) => !open)} aria-label="Open settings" title="Settings"><Settings size={18} /></button>
        </div>
      </header>
      <div className="pwa-layout">
        <aside className="pwa-sidebar">
          <div className="pwa-sidebar-head"><div><span className="pwa-kicker">Workspace</span><h1>Paired Pis</h1></div><button className="pwa-round-button" type="button" onClick={() => setPairState("scanning")} aria-label="Pair a Pi" title="Pair a Pi"><Plus size={18} /></button></div>
          <div className="pwa-peer-list">
            {peers.length === 0 ? <div className="pwa-empty"><Radio size={22} /><strong>No Pi paired yet</strong><span>Open <code>/remote-pi pair</code> in Pi and scan its QR.</span><button className="pwa-primary-button" type="button" onClick={() => setPairState("scanning")}><Link2 size={16} /> Pair a Pi</button></div> : peers.map((peer) => <PeerCard key={peer.remoteEpk} peer={peer} active={peer.remoteEpk === activePeerId} online={peer.remoteEpk === activePeerId && connection === "online"} onSelect={() => selectPeer(peer.remoteEpk)} onRename={() => void renamePeer(peer)} onRemove={() => void removePeer(peer.remoteEpk)} />)}
          </div>
          <div className="pwa-sidebar-foot"><span><span className="pwa-local-dot" /> Local workspace</span><button className="pwa-text-button" type="button" onClick={clearLocalData}>Clear data</button></div>
        </aside>
        <main className="pwa-main">
          {connection === "offline" || connection === "retrying" ? <div className="pwa-offline-banner"><WifiOff size={16} /><span>{connection === "retrying" ? "Reconnecting to Relay..." : "Offline. Local history is read-only."}</span>{connection === "retrying" ? <button className="pwa-text-button" type="button" onClick={() => void connectActivePeer()}><RefreshCw size={14} /> Retry</button> : null}</div> : null}
          {activePeer ? <><div className="pwa-chat-head"><div><span className="pwa-kicker">Active session</span><h2>{displayPeer(activePeer)}</h2><span className="pwa-chat-meta"><span className={connection === "online" ? "pwa-status-dot online" : "pwa-status-dot"} />{connection === "online" ? "Live" : "Local history"} <span className="pwa-separator">/</span> room <code>{roomId}</code></span></div><div className="pwa-room-control"><label htmlFor="room-id">Room</label><select id="room-id" value={roomId} disabled={connection !== "online"} onChange={(event) => { const next = event.target.value; setRoomId(next); roomIdRef.current = next; channelRef.current?.setRoom(next); void getPwaDatabase().settings.put({ key: `${ACTIVE_ROOM_SETTING}${activePeer.remoteEpk}`, value: next }); channelRef.current?.send({ type: "session_sync", id: id(), limit: 200 }); void listPwaMessages(activePeer.remoteEpk, next).then((storedMessages) => { messagesRef.current = storedMessages; setMessages(storedMessages); }); }}><option value={roomId}>{roomId}</option>{activeRooms.filter((room) => room.roomId !== roomId && room.online).map((room) => <option key={room.roomId} value={room.roomId}>{room.name || room.cwd || room.roomId}</option>)}</select></div></div><MessageList messages={messages} /><form className="pwa-composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={connection === "online" ? "Send a message to your agent..." : "Reconnect to send a message"} disabled={connection !== "online"} rows={2} /><button className="pwa-primary-button" type="submit" disabled={connection !== "online" || !draft.trim()}>Send <span>↗</span></button></form></> : <EmptyWorkspace onPair={() => setPairState("scanning")} />}
        </main>
        {settingsOpen ? <SettingsPanel relayUrl={relayUrl} onSave={saveRelayUrl} onClose={() => setSettingsOpen(false)} /> : null}
      </div>
      {pairState !== "idle" ? <div className="pwa-modal-backdrop">{pairState === "scanning" ? <PairingDialog onScan={pairFromQr} onClose={() => setPairState("idle")} /> : <div className="pwa-pairing-card"><Activity className="pwa-spin" /><span className="pwa-kicker">Pairing</span><h2>Connecting to your Pi</h2><p>Waiting for the Pi to confirm this browser.</p></div>}</div> : null}
      {error ? <div className="pwa-toast" role="status"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={15} /></button></div> : null}
    </div>
  );
}

function describeStartupFailure(failure: unknown): StartupError {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (message === "secure_context_required" || (typeof window !== "undefined" && !window.isSecureContext)) {
    return {
      title: "Secure connection required",
      message: "Safari blocks the browser cryptography and camera APIs on a plain LAN HTTP address. Open this app over HTTPS, or use localhost on the same device.",
      action: "Use an HTTPS address",
    };
  }
  if (message === "web_crypto_unavailable" || typeof globalThis.crypto?.getRandomValues !== "function") {
    return { title: "Browser cryptography unavailable", message: "This browser does not expose a secure random source. Open the PWA in a current Safari, Chrome, or Firefox session over HTTPS." };
  }
  if (message === "indexeddb_unavailable" || typeof indexedDB === "undefined") {
    return { title: "Local storage unavailable", message: "IndexedDB is disabled in this browser mode. Allow site data for Remote Pi and reload the page." };
  }
  if (message === "startup_timeout") {
    return { title: "Local workspace timed out", message: "The browser did not finish opening local storage. Close other Remote Pi tabs, allow site data, and try again." };
  }
  return { title: "Could not open local workspace", message: message || "The browser could not initialize the local PWA database.", action: "Reload the app" };
}

function ConnectionStatus({ state }: { state: ConnectionViewState }) {
  const label = state === "online" ? "Connected" : state === "connecting" ? "Connecting" : state === "retrying" ? "Retrying" : "Offline";
  return <span className={`pwa-connection ${state}`}><span className="pwa-status-dot" />{label}</span>;
}

function PeerCard({ peer, active, online, onSelect, onRename, onRemove }: { peer: PwaPeerRecord; active: boolean; online: boolean; onSelect: () => void; onRename: () => void; onRemove: () => void }) {
  return <div className={`pwa-peer-card ${active ? "active" : ""}`}><button className="pwa-peer-select" type="button" onClick={onSelect}><span className={`pwa-peer-icon ${online ? "online" : ""}`}><MessageSquare size={17} /></span><span className="pwa-peer-copy"><strong>{displayPeer(peer)}</strong><small>{peer.roomId || "main"} <span>/</span> {online ? "live" : "offline"}</small></span><span className="pwa-peer-state"><Circle size={8} fill="currentColor" /></span></button><button className="pwa-peer-action" type="button" onClick={onRename} aria-label={`Rename ${displayPeer(peer)}`} title="Rename pairing"><Pencil size={14} /></button><button className="pwa-peer-remove" type="button" onClick={onRemove} aria-label={`Remove ${displayPeer(peer)}`} title="Remove pairing"><Trash2 size={14} /></button></div>;
}

function MessageList({ messages }: { messages: PwaMessageRecord[] }) {
  if (messages.length === 0) return <div className="pwa-chat-empty"><div className="pwa-chat-empty-icon"><MessageSquare size={21} /></div><h3>Ready when you are.</h3><p>Your local session history will appear here.</p></div>;
  return <div className="pwa-message-list">{messages.map((message) => <article className={`pwa-message ${message.kind}`} key={message.id}><div className="pwa-message-label">{message.kind === "user" ? "You" : message.kind === "assistant" ? "Agent" : "System"}{message.status === "streaming" ? <span className="pwa-streaming"><span /> streaming</span> : null}</div>{message.kind === "assistant" ? <div className="pwa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown></div> : <p>{message.text}</p>}{message.kind !== "system" ? <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> : null}</article>)}</div>;
}

function EmptyWorkspace({ onPair }: { onPair: () => void }) {
  return <div className="pwa-zero"><div className="pwa-zero-mark">π</div><span className="pwa-kicker">Remote Pi / browser workspace</span><h2>Your agents, within reach.</h2><p>Pair a running Pi coding agent to start a live session. Everything in this browser stays local.</p><button className="pwa-primary-button" type="button" onClick={onPair}><Link2 size={16} /> Pair a Pi</button></div>;
}

function SettingsPanel({ relayUrl, onSave, onClose }: { relayUrl: string; onSave: (value: string) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(relayUrl);
  return <aside className="pwa-settings"><div className="pwa-settings-head"><div><span className="pwa-kicker">Preferences</span><h2>Settings</h2></div><button className="pwa-icon-button" type="button" onClick={onClose} aria-label="Close settings"><X size={18} /></button></div><label className="pwa-field"><span>Relay URL</span><input value={value} onChange={(event) => setValue(event.target.value)} placeholder={DEFAULT_RELAY} spellCheck={false} /><small>Use https:// for a secure relay. WebSocket is selected automatically.</small></label><div className="pwa-settings-note"><Check size={15} /><span>Owner identity and session history live in this browser only.</span></div><button className="pwa-primary-button" type="button" onClick={() => void onSave(value)}>Save settings</button></aside>;
}
