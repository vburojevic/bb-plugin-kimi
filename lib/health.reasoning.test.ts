import { describe, expect, it } from "vitest";

import { collectReasoningLevels, offersReasoningChoice } from "./health";

describe("collectReasoningLevels", () => {
  it("unions across models and sorts into BB's ladder order", () => {
    // Measured on Kimi 0.34.0: only k3 advertises efforts; the others report one.
    const models = [
      { reasoningEfforts: ["max"] },
      { reasoningEfforts: ["max"] },
      { reasoningEfforts: ["low", "high", "max"] },
    ];
    expect(collectReasoningLevels(models)).toEqual(["low", "high", "max"]);
  });

  it("reports nothing when every model carries only a placeholder", () => {
    // Measured on Kimi 0.28.1: BB substitutes one "medium" placeholder per model.
    const models = [{ reasoningEfforts: ["medium"] }, { reasoningEfforts: ["medium"] }];
    expect(collectReasoningLevels(models)).toEqual([]);
  });

  it("does not leak a placeholder into a real ladder", () => {
    // Measured on Kimi 0.31.1: placeholder is "medium" while k3 offers low/high/max.
    // Unioning naively invented a "medium" level the user cannot select.
    const models = [
      { reasoningEfforts: ["medium"] },
      { reasoningEfforts: ["low", "high", "max"] },
    ];
    expect(collectReasoningLevels(models)).toEqual(["low", "high", "max"]);
  });

  it("handles no models", () => {
    expect(collectReasoningLevels([])).toEqual([]);
  });

  it("puts unknown efforts last rather than dropping them", () => {
    const levels = collectReasoningLevels([{ reasoningEfforts: ["turbo", "high", "low"] }]);
    expect(levels).toEqual(["low", "high", "turbo"]);
  });
});

describe("offersReasoningChoice", () => {
  it("needs more than one level to be a real choice", () => {
    expect(offersReasoningChoice(["low", "high", "max"])).toBe(true);
    expect(offersReasoningChoice(["medium"])).toBe(false);
    expect(offersReasoningChoice([])).toBe(false);
  });
});
