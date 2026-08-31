"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type TimelineViewport = {
  followingOutput: boolean;
  unreadOutput: number;
  messageListRef: RefObject<HTMLDivElement | null>;
  bottomSentinelRef: RefObject<HTMLDivElement | null>;
  receiveRealtimeOutput: (groupKey: string) => void;
  handleScroll: (nearBottom: boolean) => void;
  showLatest: () => void;
  reset: () => void;
};

export function useTimelineViewport(): TimelineViewport {
  const [followingOutput, setFollowingOutput] = useState(true);
  const [unreadOutput, setUnreadOutput] = useState(0);
  const [realtimeOutputVersion, setRealtimeOutputVersion] = useState(0);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const followScrollLockRef = useRef(false);
  const followingOutputRef = useRef(followingOutput);
  const realtimeOutputKeysRef = useRef(new Set<string>());

  useEffect(() => { followingOutputRef.current = followingOutput; }, [followingOutput]);

  const reset = useCallback(() => {
    realtimeOutputKeysRef.current.clear();
    followingOutputRef.current = true;
    setFollowingOutput(true);
    setUnreadOutput(0);
  }, []);
  const receiveRealtimeOutput = useCallback((groupKey: string) => {
    if (followingOutputRef.current) {
      setRealtimeOutputVersion((version) => version + 1);
      return;
    }
    if (realtimeOutputKeysRef.current.has(groupKey)) return;
    realtimeOutputKeysRef.current.add(groupKey);
    setUnreadOutput((count) => count + 1);
  }, []);
  useEffect(() => {
    if (realtimeOutputVersion === 0 || !followingOutputRef.current) return;
    const frame = requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (followingOutputRef.current && list) list.scrollTo({ top: list.scrollHeight, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [realtimeOutputVersion]);
  const handleScroll = useCallback((nearBottom: boolean) => {
    if (nearBottom) {
      followScrollLockRef.current = false;
      reset();
    } else if (!followScrollLockRef.current) {
      if (followingOutputRef.current) realtimeOutputKeysRef.current.clear();
      followingOutputRef.current = false;
      setFollowingOutput(false);
    }
  }, [reset]);
  const showLatest = useCallback(() => {
    messageListRef.current?.scrollTo({ top: messageListRef.current.scrollHeight, behavior: "smooth" });
    reset();
  }, [reset]);

  return {
    followingOutput,
    unreadOutput,
    messageListRef,
    bottomSentinelRef,
    receiveRealtimeOutput,
    handleScroll,
    showLatest,
    reset,
  };
}
