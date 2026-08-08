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

describe("buildDesiredEntry with coalescing", () => {
  const wrapped = buildDesiredEntry({
    id: "kimi",
    displayName: "Kimi Code",
    command: "kimi",
    coalesce: true,
  });

  it("registers /bin/sh with the launch snippet and the real CLI in env", () => {
    expect(wrapped.command).toBe("/bin/sh");
    expect(wrapped.args).toHaveLength(4);
    expect(wrapped.args?.[0]).toBe("-c");
    expect(wrapped.args?.[1]).toContain("acp-coalesce.mjs");
    // $0 for the sh script, then the positional args the agent receives.
    expect(wrapped.args?.slice(2)).toEqual(["kimi-acp", "acp"]);
    expect(wrapped.env).toEqual({ KIMI_ACP_REAL: "kimi" });
  });

  it("threads a custom CLI path through env, not through the snippet", () => {
    const custom = buildDesiredEntry({
      id: "kimi",
      displayName: "Kimi Code",
      command: "/opt/tools dir/kimi",
      coalesce: true,
    });
    // The snippet is a CONSTANT — a path with spaces or shell metacharacters
    // can never corrupt it because it only ever travels as data.
    expect(custom.args?.[1]).toBe(wrapped.args?.[1]);
    expect(custom.env).toEqual({ KIMI_ACP_REAL: "/opt/tools dir/kimi" });
  });

  it("keeps identity fields identical across plain and wrapped shapes", () => {
    const plainWithLogo = buildDesiredEntry({
      id: "kimi",
      displayName: "Kimi Code",
      command: "kimi",
      logo: "/data/kimi-code.svg",
    });
    const wrappedWithLogo = buildDesiredEntry({
      id: "kimi",
      displayName: "Kimi Code",
      command: "kimi",
      logo: "/data/kimi-code.svg",
      coalesce: true,
    });
    expect(wrappedWithLogo.id).toBe(plainWithLogo.id);
    expect(wrappedWithLogo.displayName).toBe(plainWithLogo.displayName);
    expect(wrappedWithLogo.logo).toBe(plainWithLogo.logo);
  });

  it("marks the plain→wrapped transition as a change, and re-syncs as none", () => {
    const registeredPlain = upsertAgent({}, entry).config;
    const enable = upsertAgent(registeredPlain, wrapped);
    expect(enable.changed).toBe(true);

    // The same wrapped entry again: byte-stable, so sync stays idempotent and
    // never churns config.json or triggers a config reload.
    const resync = upsertAgent(enable.config, {
      ...buildDesiredEntry({
        id: "kimi",
        displayName: "Kimi Code",
        command: "kimi",
        coalesce: true,
      }),
    });
    expect(resync.changed).toBe(false);

    // And the user can toggle back to exactly the original plain shape.
    const disable = upsertAgent(enable.config, entry);
    expect(disable.changed).toBe(true);
    expect(findAgent(disable.config, "kimi")).toEqual(entry);
  });
});

describe("findAgent", () => {
  it("finds by id", () => {
    expect(findAgent({ customAcpAgents: [entry] }, "kimi")).toEqual(entry);
    expect(findAgent({ customAcpAgents: [entry] }, "nope")).toBeUndefined();
  });
});
