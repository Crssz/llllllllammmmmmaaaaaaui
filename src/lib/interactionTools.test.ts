import { describe, it, expect } from "vitest";
import { parseAskUserArgs, ASK_TOOLS, ASK_USER_TOOL } from "./interactionTools";

describe("parseAskUserArgs", () => {
  it("accepts a question with choices", () => {
    expect(parseAskUserArgs({ question: "Pick one", choices: ["A", "B"] })).toEqual({
      question: "Pick one",
      choices: ["A", "B"],
    });
  });

  it("trims the question and choices and drops blanks", () => {
    const r = parseAskUserArgs({ question: "  Pick  ", choices: ["  A  ", "", "  ", "B"] });
    expect(r.question).toBe("Pick");
    expect(r.choices).toEqual(["A", "B"]);
  });

  it("de-duplicates choices and caps them at six", () => {
    const r = parseAskUserArgs({
      question: "q",
      choices: ["A", "A", "B", "C", "D", "E", "F", "G"],
    });
    expect(r.choices).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("coerces non-string choices to strings", () => {
    const r = parseAskUserArgs({ question: "q", choices: [1, 2] });
    expect(r.choices).toEqual(["1", "2"]);
  });

  it("throws when the question is missing or empty", () => {
    expect(() => parseAskUserArgs({ choices: ["A", "B"] })).toThrow(/question/i);
    expect(() => parseAskUserArgs({ question: "   ", choices: ["A", "B"] })).toThrow(/question/i);
  });

  it("throws when fewer than two distinct choices survive", () => {
    expect(() => parseAskUserArgs({ question: "q", choices: ["A"] })).toThrow(/choices/i);
    expect(() => parseAskUserArgs({ question: "q", choices: ["A", "A"] })).toThrow(/choices/i);
    expect(() => parseAskUserArgs({ question: "q" })).toThrow(/choices/i);
  });

  it("exposes a single ask_user tool definition", () => {
    expect(ASK_TOOLS).toHaveLength(1);
    expect(ASK_TOOLS[0].name).toBe(ASK_USER_TOOL);
    expect(ASK_TOOLS[0].parameters).toMatchObject({ required: ["question", "choices"] });
  });
});
