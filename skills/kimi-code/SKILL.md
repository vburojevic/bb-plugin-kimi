---
name: kimi-code
description: Use Kimi Code (Moonshot AI) as a BB provider — spawn acp-kimi threads, pick a Kimi model, and diagnose registration, sign-in, or "provider not found" problems with the `bb kimi` command.
---

# Kimi Code in BB

Kimi Code is available in BB as the provider **`acp-kimi`**, contributed by the
`kimi` plugin. It runs Moonshot AI's `kimi` CLI as an Agent Client Protocol
server (`kimi acp`), so BB drives it the same way it drives opencode or Hermes.

## Spawning a Kimi thread

```sh
bb thread spawn --project <id> --provider acp-kimi --model kimi-code/k3 --prompt "..."
```

Models (as advertised by the CLI — always confirm with `bb kimi models`):

| Model id | Name | Notes |
| --- | --- | --- |
| `kimi-code/k3` | K3 | Default. 1M context. Reasoning: low/high/max. |
| `kimi-code/k3-256k` | K3-256k | 256K context variant. Not provisioned on every account. |
| `kimi-code/kimi-for-coding` | K2.7 Coding | 256K context. |
| `kimi-code/kimi-for-coding-highspeed` | K2.7 Coding Highspeed | Latency-optimized. |

Omit `--model` to use the project's remembered default for this provider.
Reasoning level is supported: `--reasoning-level low|high|max` on models that
advertise it (`bb kimi models` and `bb kimi doctor` show which).

## Managing the provider

```sh
bb kimi status                 # registration + per-machine health and models
bb kimi models                 # models each machine reports
bb kimi models --machine <id>  # one machine
bb kimi skills                 # skill roots Kimi discovers on a machine
bb kimi sync                   # re-register from current settings
bb kimi login                  # open a terminal running the device-code login
bb kimi doctor                 # raw ACP handshake against the BB server host
bb kimi unregister             # remove acp-kimi from BB's config
```

`bb kimi status --json` and `bb kimi doctor --json` emit machine-readable output.

## Diagnosing problems

Read `bb kimi status` first — it reports each connected machine separately, so a
provider that works locally and fails on a remote machine is visible immediately.

- **`acp-kimi` missing from `bb provider list`** — the entry is not in BB's
  config. Run `bb kimi sync`. If the plugin's `manageProvider` setting is off,
  turn it on first (`bb plugin config kimi set manageProvider true`).
- **"The Kimi Code CLI was not found on this machine's PATH"** — Kimi Code is not
  installed on that machine, or the BB host daemon's PATH cannot see it. Install
  it (<https://moonshotai.github.io/kimi-code/>), or set an absolute path:
  `bb plugin config kimi set cliPath /path/to/kimi`. Note that setting applies to
  every machine, so prefer keeping `kimi` on PATH in a multi-machine setup.
- **"Kimi Code is installed but not signed in"** — run `bb kimi login` and
  complete the device-code flow in the terminal it opens.
- **Model list empty or stale** — `bb kimi doctor` shows exactly what the CLI
  advertises over ACP on the server host.
- **Fewer models than the plan offers** — the managed model list is provisioned
  by the Kimi account at login (`kimi provider list` reports `source=oauth`), not
  by this plugin and not by the CLI version. Run `bb kimi login` to re-provision
  it. Two machines on the same account can legitimately differ if one logged in
  earlier.
- **No reasoning levels in the picker** — the CLI is too old. Builds before
  ~0.31 advertise a single `on` thinking value; newer ones advertise
  `low`/`high`/`max`. `bb kimi doctor` names the version and says so explicitly.
  Upgrade: `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`.

## What Kimi threads support

Works: streaming text, thinking blocks, tool calls, file edits with diffs, shell
commands with exit codes, permission prompts, Accept-Edits write confinement,
image input, multi-turn context, skills, model selection, reasoning levels,
session resume, MCP servers, and interrupt.

Not available — these are bb ACP-bridge limits shared by every ACP provider
(`acp-cursor`, `acp-opencode`, `acp-hermes-agent`, `acp-kimi`), not Kimi
limitations. Do not report them as bugs in this plugin or in Kimi:

- Token-usage and context-window meters, plan/todo rendering, auto thread titles,
  thread fork, archive forwarding, provider user-questions.
- `/plan` and `/goal` composer commands (only `/` skills exist), and the `/`
  skills menu itself is empty — see below.
- **bb plugin agent tools** (`accounts_quota`, `xcode_status`, `bb_workflow_run`,
  `update_environment_directory`) are NOT callable. bb spawns its MCP tool bridge
  and Kimi supports stdio MCP, but no `mcp__*` tool reaches the agent. Use the
  equivalent **`bb` CLI command** instead (e.g. `bb accounts list`) — the bb CLI
  works normally from a Kimi thread. Plugin *skills* and *instructions* DO
  arrive; only the tools are missing.
- The **"Fast" service tier** toggle is a silent no-op for Kimi.
- bb cannot install or status-check the Kimi CLI (`bb kimi status` does that).

## Skills: they work, but not from the `/` menu

**Skills DO load in Kimi threads.** Kimi Code does its own discovery at session
start and injects every skill's name, path, and description into its system
prompt. Verified: a bb Kimi thread quoted a skill's `SKILL.md` frontmatter and
listed its sibling files.

**bb's `/` composer menu will be empty for Kimi threads.** bb attributes every
skill it knows to `claude-code` or `codex` (its skill provider enum is literally
those two), and the ACP launch spec carries no `skillRoots` field. This affects
every ACP provider, not just Kimi. So: **invoke a skill by name in the prompt**
("use your shadcn skill") rather than looking for it under `/`.

`bb kimi skills [--machine <id>] [--json]` shows which roots a machine actually
uses. Kimi's documented roots, per scope, are checked in this order — and within
each group only the **first existing root wins**:

| Scope | Brand group (exclusive) | Generic group (exclusive) |
| --- | --- | --- |
| Project | `.kimi/skills` → `.claude/skills` → `.codex/skills` | `.agents/skills` |
| User | `~/.kimi/skills` → `~/.claude/skills` → `~/.codex/skills` | `~/.config/agents/skills` → `~/.agents/skills` |

Plus `extra_skill_dirs` in `~/.kimi-code/config.toml`, and Kimi's built-ins.

That exclusivity is the usual surprise: creating `~/.kimi/skills` silently hides
`~/.claude/skills`. `bb kimi skills` reports shadowed roots explicitly.

## Behavior worth knowing

- **Reasoning maps to Kimi's thinking effort.** BB maps its reasoning levels onto
  the agent's ACP `thought_level` values. Current CLIs advertise `low`, `high`,
  and `max` (on models that support efforts), which BB surfaces directly. The
  default comes from `~/.kimi-code/config.toml` (`[thinking] effort = ...`).
  Models that advertise no efforts show a single fixed level.
- **Permissions are BB's.** BB's ACP bridge answers Kimi's
  `session/request_permission` calls according to the thread's permission mode
  and enforces workspace write roots in Accept Edits mode. Kimi's own
  `--yolo` / `--auto` flags are not used and do not apply to `kimi acp`.
- **Models come from the CLI**, not from this plugin. Whatever `kimi` advertises
  after an update appears in BB automatically — there is no model list to edit.
