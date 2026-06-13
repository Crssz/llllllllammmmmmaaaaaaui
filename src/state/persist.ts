// Centralised "fire-and-forget" persistence helpers. Slices call these from
// actions so they don't need to import the logger or worry about awaiting.
import { api, type BenchRun, type ChatSession, type Settings } from "../lib/api";
import { logFailure } from "../lib/logger";

export function persistSettings(settings: Settings) {
  api.saveSettings(settings).catch(logFailure("persist", "saveSettings"));
}

export function persistChats(chats: ChatSession[]) {
  api.saveChats(chats).catch(logFailure("persist", "saveChats"));
}

export function persistBenchRuns(runs: BenchRun[]) {
  api.saveBenchRuns(runs).catch(logFailure("persist", "saveBenchRuns"));
}
