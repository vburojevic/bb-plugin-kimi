# bb-plugin-kimi

Makes **Kimi Code** (Moonshot AI) a provider in [bb](https://github.com/ymichael/bb),
alongside Codex and Claude Code. Threads run on `acp-kimi`, with Kimi's models in
bb's normal model picker.

```sh
bb plugin install .
bb thread spawn --provider acp-kimi --model kimi-code/k3 --prompt "..."
```

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
  "logo": "<dataDir>/plugins/kimi/kimi-code.svg"
}
```

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
| Thinking / reasoning blocks | ✅ `item/reasoning` |
| Tool calls + live progress | ✅ `item/toolCall` + `progress` |
| File edits with unified diffs | ✅ `item/fileChange` carries the diff |
| Shell commands, output, exit code | ✅ `item/commandExecution` |
| Permission prompts | ✅ bb answers `session/request_permission` per thread mode |
| Accept-Edits write confinement | ✅ bb enforces workspace write roots |
| Image input | ✅ Kimi advertises `promptCapabilities.image`; verified on a real image |
| Multi-turn context | ✅ |
| Skills | ✅ loaded by Kimi's own discovery — see caveat below |
| Model picker | ✅ resolved per machine |
| Reasoning levels | ✅ low/high/max on models that advertise efforts |
| Session resume | ✅ Kimi advertises `loadSession`; bb uses `session/load` |
| Kimi's own MCP servers | ✅ loaded by Kimi from its own config |
| Interrupt | ✅ bb's bridge issues `session/cancel` |
| Provider logo | ✅ |

### Not available — and not fixable from a plugin

These are properties of bb's ACP bridge, identical for **every** ACP provider
(`acp-cursor`, `acp-opencode`, `acp-hermes-agent`, `acp-kimi`). Confirmed by
comparing `GET /api/v1/system/providers` across all seven providers, and by
checking that the bridge never emits the corresponding events:

| Missing | Why |
| --- | --- |
| Token usage + context-window meter | Bridge never emits `thread/tokenUsage/updated` or `thread/contextWindowUsage/updated` |
| Plan / todo list | Bridge never emits `turn/plan/updated` |
| Auto thread titles | Bridge never emits `thread/name/updated`; `supportsRename: false` |
| Archive forwarding, fork, user questions | `supportsArchive` / `supportsFork` / `supportsUserQuestion` all `false` for ACP |
| `/plan` and `/goal` composer actions | ACP providers expose `skills` only |
| Skills in the `/` composer menu | bb's skill provider enum is literally `['claude-code','codex']`, and the ACP launch spec has no `skillRoots` field |
| bb plugin agent tools (`accounts_quota`, `xcode_status`, …) | bb spawns its `bb-acp-bridge.mjs --mcp-stdio` tool bridge, but no `mcp__*` tool reaches the agent — see below |
| "Fast" service tier | The bridge only reads `serviceTier` in the CLI-flag (`selectFlag`) model path; Kimi uses native ACP selection, so the toggle is a silent no-op |
| bb-managed CLI install / status | `providerCliStatus` covers only `codex`, `claudeCode`, `cursor`. Use `bb kimi status` instead |
| Install-docs link on a missing CLI | bb's install-docs registry has only `codex` and `acp-cursor`, so the error is generic |
| Settings → Providers page | That nav list is a hardcoded `[codex, claude-code]` constant in bb's frontend |

Kimi's own ACP `mode` option (`default`/`plan`/`auto`/`yolo`) is likewise not
driven by bb — bb owns permissions through its own modes instead.

#### bb plugin agent tools do not reach ACP threads

Worth recording because every layer looks correct in isolation:

- bb **does** build the tool list (`resolveDynamicTools` always includes at least
  `update_environment_directory`), passes it through the ACP launch spec, and
  **does** spawn the bridge — `bb-acp-bridge.mjs --mcp-stdio` is observable in
  the process list during a Kimi turn.
- Kimi **does** support stdio MCP over ACP. Verified with a purpose-built MCP
  server: Kimi called `mcp__probe-mcp__zzprobe_marker` and returned its result.
- Kimi **does** forward the ACP `env` array to stdio MCP servers, which is how
  bb's bridge is configured. Verified: the probe server read back
  `BB_PROBE_ENV=FORWARDED_OK`.
- Yet in a bb thread Kimi has **no** `mcp__*` tool, and asked to call
  `accounts_quota` it tries several invocation paths, fails, and falls back to
  the `bb accounts` CLI.
- Control test on a second ACP provider: a Hermes thread in bb lists its **own**
  MCP tools (`mcp__craft__*`, from Hermes's config) but none of bb's bridge
  tools either. So ACP agents surface MCP tools fine in general — bb's bridge
  specifically never delivers its tools, across ACP providers.

So the bridge is started but never serves its tools to the agent. Nothing in a
plugin can change that. Plugin **skills** and plugin **instructions** are
unaffected — both reach Kimi normally.

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

## Commands

```sh
bb kimi status                 # registration + per-machine health and models
bb kimi models [--machine <m>] # models each machine reports
bb kimi skills [--machine <m>] # skill roots Kimi discovers on a machine
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
| `showLogo` | `true` | Use the bundled Kimi glyph as the provider logo. |

Settings changes re-register immediately; no reload needed.

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
npx tsc --noEmit
npx vitest run
bb plugin dev .
```

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
