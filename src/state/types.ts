import type { AudioAttachment, ImageAttachment, ToolCall } from "../lib/api";

export type FlagValues = Record<string, string | number | boolean>;

export type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  time: number;
  reasoning?: string;
  meta?: { tps?: number; tokens?: number };
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
  audio?: AudioAttachment;
  image?: ImageAttachment;
};

export type PendingToolApproval = {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
};

/** An in-flight `ask_user` tool call: the model's question and the choices it
 *  offered. Resolved when the user picks one (or dismisses). */
export type PendingUserChoice = {
  id: string;
  question: string;
  choices: string[];
};
