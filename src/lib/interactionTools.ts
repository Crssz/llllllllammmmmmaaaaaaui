/**
 * Built-in "ask" toolset: lets the model pause the conversation to put a
 * multiple-choice question to the user and continue once they pick. Unlike the
 * workspace / MCP tools it doesn't call a backend — it surfaces a prompt in the
 * UI and resolves with the user's selection. Exposed to the model as
 * `ask__ask_user`, and always offered (no server / workspace to configure).
 */

export const ASK_SERVER_ID = "ask";
export const ASK_SERVER_NAME = "Ask the user";
export const ASK_USER_TOOL = "ask_user";

export type AskToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const ASK_TOOLS: AskToolDef[] = [
  {
    name: ASK_USER_TOOL,
    description:
      "Ask the user a question and let them pick from a short list of choices. " +
      "Use this when you need a decision or clarification before continuing — " +
      "choosing between approaches, confirming an assumption, or resolving a " +
      "missing detail — instead of guessing. The option the user selects is " +
      "returned to you.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to put to the user." },
        choices: {
          type: "array",
          items: { type: "string" },
          description: "Two to six short, distinct options for the user to choose from.",
        },
      },
      required: ["question", "choices"],
    },
  },
];

/**
 * Validate the `ask_user` arguments the model sent. Throws (→ the caller turns
 * it into a tool-error message the model can retry on) when they're unusable,
 * so the user never sees an empty or one-option prompt. Choices are trimmed,
 * de-duplicated, and capped at six.
 */
export function parseAskUserArgs(args: Record<string, unknown>): {
  question: string;
  choices: string[];
} {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) throw new Error("ask_user requires a non-empty 'question'");

  const raw = Array.isArray(args.choices) ? args.choices : [];
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const c of raw) {
    const s = (typeof c === "string" ? c : String(c)).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    choices.push(s);
    if (choices.length === 6) break;
  }
  if (choices.length < 2) throw new Error("ask_user requires at least two distinct 'choices'");

  return { question, choices };
}
