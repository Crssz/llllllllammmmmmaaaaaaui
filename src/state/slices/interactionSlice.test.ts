import { describe, it, expect, beforeEach } from "vitest";
import { freshStore, useAppStore } from "../testUtils";

describe("interaction slice", () => {
  beforeEach(() => {
    freshStore();
  });

  it("requestUserChoice parks a pending question and resolves on answer", async () => {
    const p = useAppStore.getState().requestUserChoice({
      id: "q1",
      question: "Pick one",
      choices: ["A", "B"],
    });
    const pending = useAppStore.getState().pendingUserChoice;
    expect(pending?.id).toBe("q1");
    expect(pending?.choices).toEqual(["A", "B"]);

    useAppStore.getState().answerUserChoice("q1", "B");

    await expect(p).resolves.toBe("B");
    // Pending state and the parked resolver are cleared.
    expect(useAppStore.getState().pendingUserChoice).toBeNull();
    expect(useAppStore.getState()._userChoiceResolve).toBeNull();
  });

  it("answerUserChoice resolves with null when the question is dismissed", async () => {
    const p = useAppStore.getState().requestUserChoice({
      id: "q2",
      question: "Pick",
      choices: ["A", "B"],
    });
    useAppStore.getState().answerUserChoice("q2", null);
    await expect(p).resolves.toBeNull();
    expect(useAppStore.getState().pendingUserChoice).toBeNull();
  });

  it("ignores an answer for a stale / mismatched id", () => {
    useAppStore.getState().requestUserChoice({ id: "q3", question: "Pick", choices: ["A", "B"] });
    useAppStore.getState().answerUserChoice("nope", "A");
    // The current question is untouched.
    expect(useAppStore.getState().pendingUserChoice?.id).toBe("q3");
  });
});
