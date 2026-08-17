# bb-plugin-kimi

Makes **Kimi Code** (Moonshot AI) a provider in [bb](https://github.com/get-bb/bb),
alongside Codex and Claude Code. Threads run on `acp-kimi`, with Kimi's models in
bb's normal model picker.

## Install

You need [Kimi Code](https://moonshotai.github.io/kimi-code/) on your PATH and a
`kimi login` you have completed at least once.

```sh
bb plugin install git:https://github.com/vburojevic/bb-plugin-kimi.git@main
bb kimi status                 # confirm registration + per-machine health
bb thread spawn --provider acp-kimi --model kimi-code/k3 --prompt "..."
```

Not signed in yet? `bb kimi login` opens a terminal running the device-code
flow. If anything looks wrong, `bb kimi doctor` prints the raw ACP handshake.

## How it works

bb's plugin API has no surface for registering an agent provider — providers are
either built in (`codex`, `claude-code`, `pi`) or declared as **custom ACP
agents** in bb's data-dir `config.json`. Kimi Code's CLI speaks the
[Agent Client Protocol](https://agentclientprotocol.com) via `kimi acp`, so this
plugin owns that declaration end to end:

1. Writes the `customAcpAgents` entry into `<dataDir>/config.json`.
2. Calls `bb.sdk.system.reloadConfig()`, so `acp-kimi` appears **without an app
   restart**.
3. Watches per-machine health and reports sign-in / install problems.
4. Removes the entry on `bb kimi unregister`.

The entry it writes is deliberately minimal:

```json
{
  "id": "kimi",
  "displayName": "Kimi Code",
  "command": "kimi",
  "args": ["acp"],
  "env": { "KIMI_MCP_TOOL_TIMEOUT_MS": "3600000" },
  "logo": "<dataDir>/plugins/kimi/kimi-code.svg"
}
```

(With progress coalescing on — the default — `command`/`args` instead point at a
small proxy. See [Tool-call progress coalescing](#tool-call-progress-coalescing).)

The env matters: bb serves plugin agent tools to Kimi over its MCP bridge, and
interactive tools (AskUserQuestion) legitimately pend on a human for most of an
hour — bb's own interaction budget caps at 60 minutes. Kimi's MCP client
otherwise times out every tool call after **60 seconds**, so any agent question
errored long before anyone could answer. `KIMI_MCP_TOOL_TIMEOUT_MS` raises that
to 60 minutes, scoped to the bb-spawned process — a terminal `kimi` keeps its
own defaults. Verified with a probe MCP server: the failure moves exactly from
60s to the configured value.

No `modelCli`, `reasoningCli`, `nativeReasoning`, or `permissionCli` — because
bb's ACP bridge already handles all four natively for Kimi:

| Concern | How it resolves |
| --- | --- |
| **Models** | Kimi advertises a `model` config option on `session/new`; bb reads it and selects via `session/set_config_option`. Model changes in the CLI show up in bb with no plugin change. |
| **Reasoning** | bb maps its levels onto the agent's `thought_level` option. Current CLIs advertise `low`/`high`/`max`, which bb surfaces as reasoning levels. Builds before ~0.31 advertise only `on`, so bb shows no choice — `bb kimi doctor` flags that explicitly. |
| **Permissions** | bb answers Kimi's `session/request_permission` per the thread's permission mode and enforces workspace write roots in Accept Edits. Kimi's `--yolo` / `--auto` are unused (and are not accepted by `kimi acp`). |
| **Auth** | Kimi advertises a `terminal`-type `login` method. bb does not drive terminal auth, so `bb kimi login` opens a bb terminal running the device-code flow. |

`command` defaults to the bare `kimi` so a single shared `config.json` stays
valid across machines with different install paths — each host daemon resolves
it on its own PATH. Set an absolute path only if you must.

### Why bb might show fewer models or levels than you expect

bb renders exactly what the CLI advertises on `session/new`, so both lists are
owned by Kimi Code, not by this plugin:

- **Models** come from the Kimi account and are provisioned **at login**
  (`kimi provider list` reports `source=oauth`). Two machines on one account can
  legitimately differ if they logged in at different times. `bb kimi login`
  re-provisions.
- **Reasoning levels** come from the CLI version. Measured: `0.28.1` advertises
  `thinking: ["on"]` (bb shows no choice); `0.31.1`+ advertises
  `["low","high","max"]` (bb shows Low/High/Max).

`bb kimi doctor` reports the version, the advertised model and thinking values,
and names whichever of these applies.

## What works in chat

Verified end to end on a live `acp-kimi` thread (event stream inspected via
`bb thread log --json`):

| Feature | Status |
| --- | --- |
| Streaming assistant text | ✅ `item/agentMessage/delta` |
| Thinking / reasoning blocks | ✅ `item/reasoning` (coalesced by the wrapper — below) |
| Tool calls + live progress | ✅ `item/toolCall` + `progress` |
| File edits with unified diffs | ✅ `item/fileChange` carries the diff |
| Shell commands, output, exit code | ✅ `item/commandExecution` |
| Accept-Edits write confinement | ✅ writes via Kimi's fs tool outside the workspace are denied cleanly |
| Full Access auto-allow | ✅ verified live: writes land without prompts |
| Image input | ✅ Kimi advertises `promptCapabilities.image`; verified on a real image |
| Multi-turn context | ✅ |
| Skills | ✅ loaded by Kimi's own discovery — see caveat below |
| Model picker | ✅ resolved per machine |
| Reasoning levels | ✅ low/high/max on models that advertise efforts |
| Session resume | ✅ Kimi advertises `loadSession`; bb uses `session/load` — plus the wrapper's healing below. Verified: full stop + reload, history intact |
| Kimi's own MCP servers | ✅ loaded by Kimi from its own config |
| **bb plugin agent tools** (`mcp__bb-bridge__*`) | ✅ served over bb's MCP bridge; AskUserQuestion round-trip verified live |
| Interrupt | ✅ bb's bridge issues `session/cancel` |
| Provider logo | ✅ |

Two permission-prompt caveats, both Kimi-side rather than bb-side:

- Under **Accept Edits**, shell commands are **not gated**: Kimi's ACP server in
  its `default` mode issues `session/request_permission` for the actions it
  considers gated, and bb can only answer what Kimi sends. In practice that
  covers fs-tool writes (confined, as above) but not shell commands — those run
  without prompting. Use Full Access deliberately.
- Interactive plugin tools (AskUserQuestion) only survive the wait because this
  plugin sets `KIMI_MCP_TOOL_TIMEOUT_MS=3600000` in the launch env — see below.

### Not available — and not fixable from a plugin

These are properties of bb's ACP bridge, identical for **every** ACP provider
(`acp-cursor`, `acp-opencode`, `acp-hermes-agent`, `acp-kimi`). Confirmed by
comparing `GET /api/v1/system/providers` across all seven providers, and by
checking that the bridge never emits the corresponding events:

| Missing | Why |
| --- | --- |
| Token usage meter | Bridge never emits `thread/tokenUsage/updated` (context-window usage **is** emitted as of bb 0.38) |
| Plan / todo list | Bridge never emits `turn/plan/updated` |
| Auto thread titles | Bridge never emits `thread/name/updated`; `supportsRename: false` |
| Archive forwarding, fork | `supportsArchive` / `supportsFork` `false` for ACP |
| `/plan` and `/goal` composer actions | ACP providers expose `skills` only |
| Skills in the `/` composer menu | bb's skill provider enum is literally `['claude-code','codex']`, and the ACP launch spec has no `skillRoots` field |
| "Fast" service tier | The bridge only reads `serviceTier` in the CLI-flag (`selectFlag`) model path; Kimi uses native ACP selection, so the toggle is a silent no-op |
| bb-managed CLI install / status | `providerCliStatus` covers only `codex`, `claudeCode`, `cursor`. Use `bb kimi status` instead |
| Install-docs link on a missing CLI | bb's install-docs registry has only `codex` and `acp-cursor`, so the error is generic |
| Settings → Providers page | That nav list is a hardcoded `[codex, claude-code]` constant in bb's frontend |

### Modes and permission presets

Kimi advertises its own modes over ACP (`default` / `plan` / `auto` / `yolo` as
a `mode` config option), but bb's ACP bridge only consumes the `model` and
`thought_level` config categories — the mode option is neither shown nor set,
so **Kimi's plan/auto/yolo modes are unreachable from bb** and every thread
runs in Kimi's `default` mode. bb then applies its own presets on top:

- **Accept Edits** — Kimi issues permission requests for gated actions; bb
  answers per preset and confines fs-tool writes to the workspace. Works.
- **Full Access** — same flow, bb auto-allows every request. Works, at the cost
  of one permission round-trip per gated tool call.
- **Approve for me (`auto`)** — unsupported for every ACP provider (bb
  hardcodes `accept-edits`/`full`); a stored `auto` preference silently becomes
  **Full Access** when a thread switches to acp-kimi. Mind the promotion.

### Skills work — the `/` menu just cannot show them

This one is worth stating plainly because the symptom looks like breakage.
Kimi Code does its **own** skill discovery at session start and injects each
skill's name, path, and description into its system prompt, so skills load in a
bb thread exactly as in the terminal. Verified by having a bb Kimi thread quote a
skill's `SKILL.md` frontmatter and list its sibling files.

What is missing is only bb's `/` composer menu. **Invoke a skill by name**
("use your shadcn skill") instead of looking for it under `/`.

`bb kimi skills [--machine <m>] [--json]` reports the roots a machine actually
uses. Kimi's documented roots are checked per scope, and within each group only
the **first existing root wins**:

| Scope | Brand group (exclusive) | Generic group (exclusive) |
| --- | --- | --- |
| Project | `.kimi/skills` → `.claude/skills` → `.codex/skills` | `.agents/skills` |
| User | `~/.kimi/skills` → `~/.claude/skills` → `~/.codex/skills` | `~/.config/agents/skills` → `~/.agents/skills` |

Plus `extra_skill_dirs` in `~/.kimi-code/config.toml`, and Kimi's built-ins.
That exclusivity is the usual surprise — creating `~/.kimi/skills` silently
hides `~/.claude/skills` — so the command reports shadowed roots explicitly.

## Session-load healing (why old threads used to lose their history)

Kimi's `session/load` validates the **workspace root recorded when the session
was created** — not the cwd bb passes on resume. bb destroys and re-provisions
worktree environments routinely, so resuming any thread whose original
directory was cleaned up failed with
`workspace root <path> does not exist`; bb's ACP bridge swallows that error and
silently continues in a **fresh session**, i.e. Kimi forgets every previous
message while the bb timeline still shows them. This was the "old Kimi threads
don't load previous messages" bug.

Since 0.2.0 the wrapper heals it in-flight: it tracks `session/load` requests,
and when the agent rejects one with that error it recreates the missing
directory (confined to `$HOME`), retries the load once, and answers bb's
original request — so history restores instead of vanishing. Disable with
`KIMI_SESSION_LOAD_HEAL=0` in the agent environment if you ever need the raw
behavior.

`bb kimi sessions` reports the same condition ahead of time: which recorded
workspace roots on a machine still exist, and how many sessions would need
healing.

## Commands

```sh
bb kimi status                 # registration + per-machine health and models
bb kimi models [--machine <m>] # models each machine reports
bb kimi skills [--machine <m>] # skill roots Kimi discovers on a machine
bb kimi sessions [--machine <m>] # which recorded sessions can still restore their history
bb kimi sync                   # re-register from current settings
bb kimi login  [--machine <m>] # open a terminal running the device-code login
bb kimi doctor                 # raw ACP handshake against the bb server host
bb kimi unregister             # remove acp-kimi from bb's config
```

`status`, `skills`, and `doctor` accept `--json`.

## Settings

| Key | Default | Purpose |
| --- | --- | --- |
| `cliPath` | `""` | Absolute path to `kimi`. Empty uses the bare `kimi` on each host's PATH. |
| `displayName` | `Kimi Code` | Provider name shown in bb. |
| `manageProvider` | `true` | Turn off to stop the plugin touching `config.json`. |
| `coalesceProgress` | `true` | Route the agent through the progress coalescer (below). |
| `showLogo` | `true` | Use the bundled Kimi glyph as the provider logo. |

Settings changes re-register immediately; no reload needed.

## Tool-call progress coalescing

bb persists **every** ACP `session/update` notification as a row in its event
store. Kimi streams a `tool_call_update` snapshot for each terminal-output tick,
so one long-running command can write tens of thousands of ~4KB rows. In the
session that motivated this, two threads grew `bb.db` to 576MB and pinned the bb
server's main thread in synchronous SQLite scans — the whole app stuttered.
Kimi's reasoning stream is the same firehose on a second channel: one tiny
`agent_thought_chunk` per token-ish tick, ~15k persisted rows in a single
30-minute thread.

The agent cannot be told to stream less, and the bridge is bb core, so the one
seam a plugin owns is the spawned process. With `coalesceProgress` on, the
registered command becomes:

```jsonc
{
  "command": "/bin/sh",
  "args": ["-c", "<launch snippet>", "kimi-acp", "acp"],
  "env": { "KIMI_ACP_REAL": "kimi" }
}
```

The snippet runs `$HOME/.bb/plugins/kimi/acp-coalesce.mjs` when that file and
`node` are present, and otherwise `exec`s the plain CLI — so a machine the
plugin has not reached yet degrades to stock behaviour instead of breaking. The
plugin materializes that proxy on every connected machine and refreshes it on a
sweep, so late-joining hosts are covered.

**It is lossless.** ACP `tool_call_update` fields *replace* prior values rather
than appending, so merging a run of updates per `(sessionId, toolCallId)` —
newest field wins — and emitting the merged snapshot is semantically identical
to delivering every tick. Thought chunks are the opposite: their text *appends*
to the session's open reasoning item (bb concatenates every delta itself), so
concatenating a contiguous run per session is identical too — and every message
type bb uses to close a reasoning item (new tool call, message chunk, turn end)
is non-coalescable, so run boundaries land exactly where bb would put them.
Terminal statuses flush immediately, and any non-coalescable message flushes
held state first, so ordering bb can observe is preserved. A representative
60-chunk command now writes **17 events / 3KB** with zero progress rows, and a
thinking-heavy turn writes one reasoning event per throttle window instead of
one per token tick.

Tuning, mostly for debugging:

| Variable | Default | Effect |
| --- | --- | --- |
| `KIMI_COALESCE_MS` | `500` | Max snapshot rate per tool call / thought stream. `0` disables coalescing. |
| `KIMI_MAX_LINE_BYTES` | `33554432` | Lines above this stream through verbatim instead of being buffered. |

Turn the whole thing off with `bb plugin config kimi set coalesceProgress false`.

## Safety notes

`config.json` is shared with bb's `machineCredential`, `connectMachineId`,
`serverUrl`, `config`, and `customModels`. Every write here is a merge that
preserves unknown keys and sibling ACP agents, malformed JSON throws rather than
being replaced, and writes go through a temp file + rename. `lib/agent-config.test.ts`
covers those guarantees.

The plugin does **not** remove its config entry on dispose — dispose also runs on
every plugin reload, and pulling the provider out from under a running Kimi
thread would break it. Use `bb kimi unregister`.

## Development

```sh
npm install
npm run typecheck
npm test          # 135 tests
bb plugin dev .
```

The suite spawns real processes rather than mocking them: the coalescer tests
run the actual materialized proxy against scripted fake agents (coalescing,
ordering, UTF-8 across chunk boundaries, backpressure, oversized lines, signal
handling), `lib/launch-snippet.test.ts` drives the real `/bin/sh` fallback
chain, and `lib/shell-quote.test.ts` round-trips hostile paths through a shell.
`server.test.ts` runs the plugin factory against a fake bb host.

A note if you touch `lib/wrapper.ts`: the proxy is embedded as the
`WRAPPER_SOURCE` template literal, so escaping is load-bearing — a backtick or
`${` inside it terminates the literal, and `\n` must be written `\\n`. Verify
changes against the emitted file, not just the literal.

## License

MIT — see [LICENSE](LICENSE).

"Kimi" and the Kimi mark are trademarks of Moonshot AI. This is an unofficial,
community-maintained plugin and is not affiliated with or endorsed by Moonshot AI.

## Branding

The provider icon follows bb's own provider-icon convention — a flat,
transparent, edge-to-edge glyph in a 24×24 box, like the inline `currentColor`
icons bb ships for Codex, Claude Code, Cursor, and opencode. No tile, no
background.

Two assets share identical geometry:

| Asset | Where | Rendering |
| --- | --- | --- |
| `assets/icon.svg` | manifest `bb.branding.icon` | CSS mask — inherits the surrounding text color, so it is always correct |
| `lib/logo.ts` → `<dataDir>/plugins/kimi/kimi-code.svg` | provider `logo` | rendered as an `<img>`, so it **cannot** inherit `currentColor` or know the active theme; it uses a fixed neutral grey (`#5F5F5F`, `#9A9A9A` dark) via `prefers-color-scheme` |

The K is a contour trace of the official Kimi Code mark published at
[moonshotai.github.io/kimi-code](https://moonshotai.github.io/kimi-code)
(`assets/Kimi.CThWxdLR.png`, 316×316), simplified to 18 points at **97.5% shape
IoU**.

### Why the provider logo is grey, not branded

bb inlines a `currentColor` SVG component only for its built-in providers and
its four known ACP agents (`grok`, `hermes-agent`, `opencode`, `omp`). A custom
ACP agent's `logo` always goes through `<img>`, which cannot participate in
theming. So the colour is chosen to be unobtrusive in *every* theme rather than
exact in one:

| | luminance |
| --- | --- |
| bb default dark `--muted-foreground` `oklch(78% 0 0)` ≈ `#B7B7B7` | 183 |
| Ayu Dark muted (measured from the real provider row) `#9A9193` | 148 |
| **this glyph, dark `#9A9A9A`** | **154** |

An earlier version used bb's Cursor pair (`#111827` / `#F5F5F5`). On Ayu Dark
that rendered *brighter than the theme's own foreground* (`#BFBDB6`, luma 189)
and stood out badly. Being a little dimmer than neighbours reads as muted; being
brighter reads as broken.

It is monochrome on purpose — no other icon in that row carries a colour accent,
so Kimi's brand blue is dropped here. Measured against the real row, the glyph
box is 32×30 next to codex/claude at 32×32 and hermes at 30×32, with the
*lightest* ink coverage of the seven, so size and weight already matched.

The only way to get a truly theme-reactive icon is for bb to ship an inline
`kimi` entry in that known-agent map — a bb change, not a plugin one.

"Kimi" and the Kimi mark are trademarks of Moonshot AI. Set `showLogo` to
`false` to drop the provider logo.
