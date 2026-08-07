import { describe, expect, it } from "vitest";

import {
  buildDesiredEntry,
  entriesEqual,
  findAgent,
  listAgents,
  parseConfig,
  removeAgent,
  upsertAgent,
} from "./agent-config";

const entry = buildDesiredEntry({ id: "kimi", displayName: "Kimi Code", command: "kimi" });

describe("parseConfig", () => {
  it("treats a missing or empty file as an empty config", () => {
    expect(parseConfig(null)).toEqual({});
    expect(parseConfig("   ")).toEqual({});
  });

  it("refuses to interpret malformed JSON as empty", () => {
    expect(() => parseConfig("{ nope")).toThrow(/not valid JSON/u);
  });

  it("rejects non-object roots rather than overwriting them", () => {
    expect(() => parseConfig("[]")).toThrow(/must contain a JSON object/u);
    expect(() => parseConfig("null")).toThrow(/must contain a JSON object/u);
  });
});

describe("listAgents", () => {
  it("tolerates a missing or malformed customAcpAgents value", () => {
    expect(listAgents({})).toEqual([]);
    expect(listAgents({ customAcpAgents: "nonsense" })).toEqual([]);
  });

  it("skips non-object array members", () => {
    expect(listAgents({ customAcpAgents: [entry, null, 7, "x"] })).toEqual([entry]);
  });
});

describe("upsertAgent", () => {
  it("preserves unrelated top-level keys", () => {
    const before = {
      machineCredential: "secret-credential",
      connectMachineId: "host_1",
      serverUrl: "http://127.0.0.1:38886",
      config: { BB_LOG_LEVEL: "debug" },
      customModels: [{ id: "m" }],
    };
    const { config, changed } = upsertAgent(before, entry);
    expect(changed).toBe(true);
    expect(config.machineCredential).toBe("secret-credential");
    expect(config.connectMachineId).toBe("host_1");
    expect(config.serverUrl).toBe("http://127.0.0.1:38886");
    expect(config.config).toEqual({ BB_LOG_LEVEL: "debug" });
    expect(config.customModels).toEqual([{ id: "m" }]);
  });

  it("preserves sibling agents and replaces in place", () => {
    const other = { id: "other", displayName: "Other", command: "other", args: ["acp"] };
    const stale = { ...entry, command: "/old/path/kimi" };
    const { config, changed } = upsertAgent({ customAcpAgents: [stale, other] }, entry);
    expect(changed).toBe(true);
    expect(config.customAcpAgents).toEqual([entry, other]);
  });

  it("appends when the agent is absent", () => {
    const other = { id: "other", displayName: "Other", command: "other" };
    const { config } = upsertAgent({ customAcpAgents: [other] }, entry);
    expect(config.customAcpAgents).toEqual([other, entry]);
  });

  it("reports no change for an identical entry so reloads do not rewrite", () => {
    const { config, changed } = upsertAgent({ customAcpAgents: [{ ...entry }] }, entry);
    expect(changed).toBe(false);
    expect(config.customAcpAgents).toEqual([entry]);
  });

  it("detects a changed display name", () => {
    const renamed = buildDesiredEntry({ id: "kimi", displayName: "Kimi", command: "kimi" });
    expect(upsertAgent({ customAcpAgents: [entry] }, renamed).changed).toBe(true);
  });
});

describe("removeAgent", () => {
  it("drops the key entirely when the last agent is removed", () => {
    const { config, changed } = removeAgent({ machineCredential: "s", customAcpAgents: [entry] }, "kimi");
    expect(changed).toBe(true);
    expect(config).toEqual({ machineCredential: "s" });
  });

  it("keeps siblings", () => {
    const other = { id: "other", displayName: "Other", command: "other" };
    const { config } = removeAgent({ customAcpAgents: [entry, other] }, "kimi");
    expect(config.customAcpAgents).toEqual([other]);
  });

  it("is a no-op when absent", () => {
    expect(removeAgent({}, "kimi").changed).toBe(false);
  });
});

describe("entriesEqual", () => {
  it("ignores key order", () => {
    expect(entriesEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
  });

  it("respects array order", () => {
    expect(entriesEqual({ args: ["acp", "x"] }, { args: ["x", "acp"] })).toBe(false);
  });
});

describe("buildDesiredEntry", () => {
  it("launches the ACP server and declares no CLI flag overrides", () => {
    expect(entry).toEqual({
      id: "kimi",
      displayName: "Kimi Code",
      command: "kimi",
      args: ["acp"],
    });
  });

  it("includes a logo only when one is supplied", () => {
    const withLogo = buildDesiredEntry({
      id: "kimi",
      displayName: "Kimi Code",
      command: "kimi",
      logo: "/data/kimi-code.svg",
    });
    expect(withLogo.logo).toBe("/data/kimi-code.svg");
    expect("logo" in entry).toBe(false);
  });
});

describe("findAgent", () => {
  it("finds by id", () => {
    expect(findAgent({ customAcpAgents: [entry] }, "kimi")).toEqual(entry);
    expect(findAgent({ customAcpAgents: [entry] }, "nope")).toBeUndefined();
  });
});
