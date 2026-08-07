import { describe, expect, it } from "vitest";

import { ACP_DEFAULT_MODEL_ID, describeLoadError, resolveHostErrorCode } from "./health";

const kimiModels = [
  { id: "kimi-code/k3" },
  { id: "kimi-code/kimi-for-coding" },
  { id: "kimi-code/kimi-for-coding-highspeed" },
];

describe("resolveHostErrorCode", () => {
  it("is healthy when a real Kimi catalog came back", () => {
    expect(resolveHostErrorCode({ models: kimiModels, modelLoadError: null })).toBeNull();
  });

  it("flags a catalog of only acp-default, which BB reports without an error", () => {
    // Regression: a nonexistent CLI path produced exactly this shape and was
    // previously reported as "ok — 1 model".
    expect(
      resolveHostErrorCode({ models: [{ id: ACP_DEFAULT_MODEL_ID }], modelLoadError: null }),
    ).toBe("unresolved_catalog");
  });

  it("flags an empty catalog", () => {
    expect(resolveHostErrorCode({ models: [], modelLoadError: null })).toBe("unresolved_catalog");
  });

  it("prefers an explicit modelLoadError over catalog inspection", () => {
    expect(resolveHostErrorCode({ models: [], modelLoadError: "auth_required" })).toBe(
      "auth_required",
    );
    expect(resolveHostErrorCode({ models: kimiModels, modelLoadError: "timeout" })).toBe("timeout");
  });

  it("stays healthy when a real model sits alongside the placeholder", () => {
    expect(
      resolveHostErrorCode({
        models: [{ id: ACP_DEFAULT_MODEL_ID }, { id: "kimi-code/k3" }],
        modelLoadError: null,
      }),
    ).toBeNull();
  });
});

describe("describeLoadError", () => {
  it("has no message for a healthy host", () => {
    expect(describeLoadError(null)).toBeNull();
  });

  it("points auth failures at the login command", () => {
    expect(describeLoadError("auth_required")).toMatch(/bb kimi login/u);
  });

  it("points an unresolved catalog at the doctor command", () => {
    expect(describeLoadError("unresolved_catalog")).toMatch(/bb kimi doctor/u);
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(describeLoadError("something_new")).toMatch(/failed to report its models/u);
  });
});
