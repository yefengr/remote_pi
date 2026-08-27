"use client";

import { useState, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, MessageSquare, RefreshCw, X } from "lucide-react";
import type { TimelineEvent, TimelinePartial } from "@/lib/remote-pi/protocol-v2/schema";
import type { TimelinePending, TimelineViewItem } from "@/lib/pwa/timeline-runtime";

type MessageListProps = {
  items: TimelineViewItem[];
  hasEarlier: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  listRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onRetryUnknown?: (clientRequestId: string) => void;
  onCancelQueued?: (clientRequestId: string) => void;
};

function blockText(event: TimelineEvent | TimelinePartial): string {
  if ("blocks" in event && event.blocks) return event.blocks.map((block) => ("text" in block ? block.text : "")).join("\n");
  return "delta" in event && event.delta ? event.delta : "";
}

function userLabel(event: Extract<TimelineEvent, { kind: "user" }>): string {
  if (event.origin === "pwa") return event.delivery === "queued" ? "Queued" : "You";
  if (event.origin === "extension") return "Remote";
  return "Unknown";
}

function eventText(event: TimelineEvent): string {
  if (event.kind === "user" || event.kind === "assistant") return blockText(event);
  if (event.kind === "provider_error") return event.message;
  if (event.kind === "tool") return event.error ?? JSON.stringify(event.result ?? event.args, null, 2);
  if (event.kind === "compaction") return typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
  if (event.kind === "branch_summary" || event.kind === "custom") return typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
  return "";
}

function UserBlocks({ event }: { event: Extract<TimelineEvent, { kind: "user" }> }) {
  return <div className="pwa-user-blocks">{event.blocks.map((block, index) => block.type === "text" ? <p key={index}>{block.text}</p> : "omitted" in block ? <div className="pwa-image-omitted" key={index}>Image not included · {block.mime_type} · {block.byte_length.toLocaleString()} bytes</div> : <img className="pwa-message-image" key={index} src={`data:${block.mime_type};base64,${block.data}`} alt={`User attachment ${index + 1}`} />)}</div>;
}

function EventCard({ event }: { event: TimelineEvent }) {
  const [expanded, setExpanded] = useState(event.kind !== "tool");
  const collapsible = event.kind === "tool" || (event.kind === "assistant" && event.blocks.some((block) => block.type === "thinking"));
  const label = event.kind === "user" ? userLabel(event) : event.kind === "assistant" ? "Agent" : event.kind === "tool" ? `Tool / ${event.tool}` : event.kind === "provider_error" ? "Provider error" : "System";
  const text = eventText(event);
  return <article className={`pwa-message ${event.kind}`}>
    <div className="pwa-message-label">{label}{event.kind === "tool" ? <span className={`pwa-interrupted ${event.status}`}>{event.status}</span> : null}{collapsible ? <button type="button" className="pwa-message-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}><ChevronDown size={14} /></button> : null}</div>
    {expanded || !collapsible ? event.kind === "user" ? <UserBlocks event={event} /> : event.kind === "assistant" || event.kind === "provider_error" ? <div className="pwa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div> : <p>{text}</p> : null}
    <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
  </article>;
}

function PendingCard({ pending, onRetryUnknown, onCancelQueued }: { pending: TimelinePending; onRetryUnknown?: (clientRequestId: string) => void; onCancelQueued?: (clientRequestId: string) => void }) {
  const label = pending.delivery === "unknown_delivery" ? "Unknown" : pending.delivery === "accepted" ? "Queued" : "You";
  const queued = pending.delivery === "accepted" && pending.messageId === undefined && pending.cancelable === true;
  return <article className="pwa-message user pending"><div className="pwa-message-label">{label}<span className="pwa-streaming"><span /> {pending.delivery === "unknown_delivery" ? "delivery unknown" : pending.delivery}</span>{pending.delivery === "unknown_delivery" && onRetryUnknown ? <button className="pwa-pending-retry" type="button" onClick={() => onRetryUnknown(pending.clientRequestId)} aria-label="Retry delivery" title="Retry delivery"><RefreshCw size={14} /></button> : null}{queued && onCancelQueued ? <button className="pwa-pending-retry" type="button" onClick={() => onCancelQueued(pending.clientRequestId)} aria-label="Cancel queued message" title="Cancel queued message"><X size={14} /></button> : null}</div><div className="pwa-user-blocks">{pending.text ? <p>{pending.text}</p> : null}{pending.images?.map((image, index) => <img className="pwa-message-image" key={index} src={`data:${image.mime};base64,${image.data}`} alt={`User attachment ${index + 1}`} />)}</div><time>{new Date(pending.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></article>;
}

function PartialCard({ partial }: { partial: TimelinePartial }) {
  const text = blockText(partial);
  const label = partial.kind === "tool" ? `Tool / ${partial.tool}` : partial.kind === "thinking" ? "Thinking" : "Agent";
  return <article className={`pwa-message ${partial.kind} partial`}><div className="pwa-message-label">{label}<span className="pwa-streaming"><span /> streaming</span></div>{text.trim() ? partial.kind === "assistant" ? <div className="pwa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div> : <p>{text}</p> : null}</article>;
}

export function MessageList({ items, hasEarlier, loadingEarlier, onLoadEarlier, listRef, bottomSentinelRef, onScroll, onRetryUnknown, onCancelQueued }: MessageListProps) {
  return <div className="pwa-message-list" ref={listRef} onScroll={onScroll}>
    {hasEarlier ? <button className="pwa-secondary-button pwa-earlier-button" type="button" onClick={onLoadEarlier} disabled={loadingEarlier}>{loadingEarlier ? "Loading earlier records…" : "Load earlier records"}</button> : null}
    {items.length === 0 ? <div className="pwa-chat-empty"><div className="pwa-chat-empty-icon"><MessageSquare size={21} /></div><h3>Ready when you are.</h3><p>Your local session history will appear here.</p></div> : items.map((item) => item.kind === "event" ? <EventCard event={item.event} key={item.event.event_id} /> : item.kind === "pending" ? <PendingCard pending={item} key={item.id} onRetryUnknown={onRetryUnknown} onCancelQueued={onCancelQueued} /> : <PartialCard partial={item.partial} key={item.partial.partial_id} />)}
    <div ref={bottomSentinelRef} aria-hidden="true" className="pwa-bottom-sentinel" />
  </div>;
}
