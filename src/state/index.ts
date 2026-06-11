// Public surface of the state module. Components should import from here.
//
// Selecting state: `useAppStore(s => s.foo)` subscribes to a single value.
// For multiple values use `useShallow` to avoid re-rendering on unrelated
// updates:
//   import { useShallow } from "zustand/react/shallow";
//   const { a, b } = useAppStore(useShallow((s) => ({ a: s.a, b: s.b })));
export { useAppStore, resetAppStore, type AppStore } from "./store";
export { AppEffects, useAppEffects } from "./effects";
export type { ChatMessage, PendingToolApproval, FlagValues } from "./types";

// Re-export pure helpers so consumers don't need to know where they live.
export { splitThink, mcpResultToText, deriveTitle, toView, fromView } from "../lib/chatHelpers";

// Convenience hook that returns a memoized view-friendly version of the
// current chat's messages. Subscribes only to the current chat (not the whole
// chats array), so unrelated chat edits don't cause re-renders.
import { useAppStore } from "./store";
import { toView } from "../lib/chatHelpers";
import { useMemo } from "react";

export function useCurrentChat() {
  return useAppStore((s) => s.chats.find((c) => c.id === s.currentChatId) ?? null);
}

export function useChatMessages() {
  const chat = useCurrentChat();
  return useMemo(() => toView(chat?.messages ?? []), [chat]);
}
