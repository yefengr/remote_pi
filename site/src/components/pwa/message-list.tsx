"use client";

import type { RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquare } from "lucide-react";
import type { PwaMessageRecord } from "@/lib/pwa/db";

type MessageListProps = {
  messages: PwaMessageRecord[];
  listRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
};

export function MessageList({ messages, listRef, bottomSentinelRef, onScroll }: MessageListProps) {
  return (
    <div className="pwa-message-list" ref={listRef} onScroll={onScroll}>
      {messages.length === 0 ? (
        <div className="pwa-chat-empty">
          <div className="pwa-chat-empty-icon"><MessageSquare size={21} /></div>
          <h3>Ready when you are.</h3>
          <p>Your local session history will appear here.</p>
        </div>
      ) : messages.map((message) => (
        <article className={`pwa-message ${message.kind}`} key={message.id}>
          <div className="pwa-message-label">
            {message.kind === "user" ? "You" : message.kind === "assistant" ? "Agent" : "System"}
            {message.status === "streaming" ? <span className="pwa-streaming"><span /> streaming</span> : null}
          </div>
          {message.kind === "assistant" ? (
            <div className="pwa-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown></div>
          ) : <p>{message.text}</p>}
          {message.kind !== "system" ? <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> : null}
        </article>
      ))}
      <div ref={bottomSentinelRef} aria-hidden="true" className="pwa-bottom-sentinel" />
    </div>
  );
}
