import type { StateCreator } from "zustand";
import { log } from "../../lib/logger";
import type { PendingUserChoice } from "../types";
import type { AppStore } from "../store";

/**
 * Pause/resume primitive for the built-in `ask_user` tool. Mirrors the tool-
 * approval mechanism: `requestUserChoice` parks a promise and surfaces the
 * question in the UI; the question modal resolves it via `answerUserChoice`
 * when the user picks an option (or dismisses, → null).
 */
export type InteractionSlice = {
  pendingUserChoice: PendingUserChoice | null;
  _userChoiceResolve: ((answer: string | null) => void) | null;
  requestUserChoice: (req: PendingUserChoice) => Promise<string | null>;
  answerUserChoice: (id: string, answer: string | null) => void;
};

export const createInteractionSlice: StateCreator<AppStore, [], [], InteractionSlice> = (
  set,
  get,
) => ({
  pendingUserChoice: null,
  _userChoiceResolve: null,

  requestUserChoice: (req) =>
    new Promise<string | null>((resolve) => {
      set({ _userChoiceResolve: resolve, pendingUserChoice: req });
    }),

  answerUserChoice: (id, answer) => {
    const { _userChoiceResolve: cb, pendingUserChoice: req } = get();
    if (!req || req.id !== id) return; // stale / mismatched answer — ignore
    set({ _userChoiceResolve: null, pendingUserChoice: null });
    log.info("ask", answer == null ? "question dismissed" : "user chose an option");
    cb?.(answer);
  },
});
