import type { ToolCall } from "../lib/api";

export type FlagValues = Record<string, string | number | boolean>;

export type Agency = "manual" | "suggest" | "auto";

export type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  time: number;
  reasoning?: string;
  meta?: { tps?: number; tokens?: number };
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
};

export type PendingToolApproval = {
  id: string;
  serverId: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
};
