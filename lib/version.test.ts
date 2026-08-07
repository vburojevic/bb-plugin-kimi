import { describe, expect, it } from "vitest";

import {
  MIN_VERIFIED_VERSION,
  compareVersions,
  describeVersionGap,
  exposesReasoningLevels,
} from "./version";

describe("compareVersions", () => {
  it("orders by numeric segment, not lexically", () => {
    // The bug this guards: "0.9.0" > "0.31.1" under string comparison.
    expect(compareVersions("0.9.0", "0.31.1")).toBeLessThan(0);
    expect(compareVersions("0.28.1", "0.31.1")).toBeLessThan(0);
    expect(compareVersions("0.34.0", "0.31.1")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal, with or without a v prefix", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("pads missing segments with zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
  });
});

describe("describeVersionGap", () => {
  it("warns for the version measured to under-report", () => {
    const gap = describeVersionGap("0.28.1");
    expect(gap).not.toBeNull();
    expect(gap).toMatch(/0\.28\.1/u);
    expect(gap).toMatch(/install\.sh/u);
  });

  it("is silent at and above the verified version", () => {
    expect(describeVersionGap(MIN_VERIFIED_VERSION)).toBeNull();
    expect(describeVersionGap("0.34.0")).toBeNull();
  });

  it("stays silent when the version is unknown rather than guessing", () => {
    expect(describeVersionGap(null)).toBeNull();
  });
});

describe("exposesReasoningLevels", () => {
  it("rejects the single 'on' value old builds advertise", () => {
    expect(exposesReasoningLevels({ values: ["on"] })).toBe(false);
  });

  it("accepts the low/high/max ladder newer builds advertise", () => {
    expect(exposesReasoningLevels({ values: ["low", "high", "max"] })).toBe(true);
  });

  it("needs more than one selectable value to be a real choice", () => {
    expect(exposesReasoningLevels({ values: ["max"] })).toBe(false);
    expect(exposesReasoningLevels({ values: [] })).toBe(false);
  });

  it("ignores values outside BB's ladder", () => {
    expect(exposesReasoningLevels({ values: ["on", "off", "turbo"] })).toBe(false);
  });
});
