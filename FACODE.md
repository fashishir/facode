# FACODE — Project Memory

FA Code is a Claude Code–style CLI agent with REA (Reverse Engineering Anything) at its core.
This file is the project memory: decisions, architecture, and gotchas that are not obvious
from the code alone. Keep it updated as the project evolves.

## Vision
A single TypeScript CLI (`facode`) that feels like Claude Code but is built around REA:
- OpenAI-compatible LLM backend (configurable provider, model, base URL, API key).
- REA integrated **twice**: (1) as agent-callable tools via `rea-mcp`, and (2) as a
  specialized `reverse-engineer` subagent that the main agent delegates to for deep dives.
- Claude Code UX: streaming TUI (Ink), slash commands, tool permission prompts, plan mode,
  context compaction, skills, sessions, memory files.

## Architecture (v0.1 skeleton)
```
src/
  index.ts        CLI entry + arg parse
  cli.ts          slash-command router (/init, /compact, /clear, /help, /model, /permissions...)
  agent/
    loop.ts       Agent tool-calling loop (stream → tool calls → feed results → repeat)
    provider.ts   OpenAI-compatible streaming client (provider abstraction)
    compaction.ts Context compaction (summarize old turns)
    subagents.ts  Subagent registry incl. reverse-engineer (REA) subagent
  tools/
    registry.ts   Tool registration + schema emission
    bash.ts       Bash tool (with allow/deny/ask permission gating)
    read.ts       Read tool
    write.ts      Write tool
    edit.ts       Edit tool (string replace)
    glob.ts       Glob tool
    grep.ts       Grep tool
    rea.ts        REA tool wrappers -> call rea-mcp MCP server
  tui/
    app.tsx       Root Ink app (<Static> transcript + live turn + input + status)
    chat.tsx      Message renderer (user/assistant/tool/thinking)
    chat-history.tsx  Static transcript flusher + per-message markdown renderer
    input.tsx     Input box (owns its value state; slash menu, history nav)
    permission.tsx Permission prompt (allow/deny/always)
    permission-prompt.tsx Interactive [y/a/d/p] approvals with diff previews
    select-list.tsx   Arrow-key list overlay (windowed; both pickers use it)
    model-picker.tsx  Endpoint model chooser for /model pick
    provider-form.tsx Guided custom-provider form for /provider add
    status.tsx    Status line (model, cwd, token count, permission mode)
    status-line.tsx Animated status line (spinner, mode badge, REA status)
    theme.ts      Color tokens
  session/
    store.ts      Session persistence (JSONL + summary)
    context.ts    Context window management
  config.ts       Config loading (env + .facode/config.json)
  permissions.ts  Permission modes: default | plan | auto
  skills.ts       Skill loader (.facode/skills/*/SKILL.md)
  mcp.ts          MCP client manager (connects rea-mcp, exposes tools)
  utils.ts        Path, fs, misc helpers
```

## Key decisions
- **Build**: TypeScript (ESM), compiled via `tsc`, shipped as `bin/facode.js`.
- **Global command**: the package is unpublished; the machine registers it with
  `npm link` (creates `facode.cmd`/`facode.ps1`/bash shim in `%APPDATA%\npm`, which is on
  PATH). After edits run `npm run build` — the linked command executes `dist/index.js`
  directly, so a stale dist ships stale behavior.
- **TUI**: Ink 8 + React. Terminal-first, falls back to plain text stream on non-TTY.
- **LLM**: `openai` SDK v7 (OpenAI-compatible). Provider switchable via `FACODE_BASE_URL`,
  `FACODE_API_KEY`, `FACODE_MODEL` env vars or `.facode/config.json`.
- **Tools**: Each tool exports `{ name, description, inputSchema, execute(ctx, args) }`.
  The loop emits tool calls from the model, gates them through permissions, executes, and
  feeds `tool_result` back as `role: "tool"`.
- **REA integration**: `rea-mcp` (the `rea-agents` MCP server, `mcpName: io.github.morluto/rea`)
  is started as a stdio MCP subprocess. `mcp.ts` connects to it, lists its tools, and exposes
  them to the agent. The `reverse-engineer` subagent is a prebuilt agent profile whose system
  prompt instructs it to use REA tools for decompile/analyze/inspect/compare/capture tasks.
- **Permissions**: `default` (ask on every tool), `plan` (write/edit require approval,
  read-only auto), `auto` (no prompts). Persisted per project in `.facode/permissions.json`.
- **Compaction**: When context exceeds ~80% of window, summarize the oldest turns into a
  single `system`-level summary message and drop the originals.

## Environment / gotchas
- **Windows spawn**: `spawn("npx", ...)` fails with ENOENT on win32 (`npx` is a `.cmd`
  shim; also `.cmd`/`.bat` must be spawned with `shell: true`). `src/mcp.ts` resolves the
  globally installed `rea-agents` entry and spawns `node <npm root -g>/rea-agents/scripts/rea.mjs mcp`
  directly; the same `resolveReaCli()` is used by the builtin `rea_*` tools. The generic
  `resolveServerCommand()` handles `.cmd` shims for any configured MCP server.
- REA analysis engines (Hopper, Ghidra, IDA, jadx) are **optional**. `rea doctor` reports
  them as missing and exits non-zero — the `rea_doctor` tool returns the report anyway.
  REA falls back to available engines. Do not hard-depend on them.
- `rea-agents@6.7.0` is installed globally. Its MCP server serves **207 tools** over
  newline-delimited JSON-RPC on stdio (`scripts/rea.mjs mcp`). `mcp.ts` talks to it via a
  line-buffered `RpcConnection` that matches responses by id and tolerates notifications.
  MCP tool input schemas are passed through raw (`Tool.jsonSchema`) — converting them
  through `z.any()` produces `{type:"string"}` which the API rejects as invalid parameters.
- **Paths**: `SESSIONS_DIR`/`PERMISSIONS_FILE` are relative to the project `.facode/` dir —
  combine with `facodeDir(cwd)`. They must NOT embed `.facode` again (that once created a
  nested `.facode/.facode/sessions`).
- This machine's project folder is **untracked inside the parent `D:\` git repo**, so
  `git ls-files` returns empty — the Glob tool falls back to a filesystem walk + minimatch
  when git returns nothing.
- **LLM backend**: this environment uses the Token Harbor proxy (`OPENAI_BASE_URL`), which
  has no `gpt-4o`. `.facode/config.json` pins `deepseek-v4.1-flash:free` (free tier,
  tool-calling capable). On model-404 the provider now lists the live models from
  `GET /v1/models` in the error message.
- **Config layering (v0.3)**: defaults < user (`~/.facode/config.json`, override with
  `FACODE_USER_DIR` for tests) < project (`.facode/config.json`) < `FACODE_*` env. The user
  layer is what makes facode work from ANY directory, not just projects carrying their own
  config. The built-in `openai` preset honors `OPENAI_BASE_URL` when set (a proxy key sent
  to api.openai.com 401s — the zero-config fallback must not hard-code the official URL).
- **No silent config persistence**: CLI flags (`--model`, `--provider`,
  `--permission-mode`) and `FACODE_*` env overrides apply in memory only — `index.ts` used
  to `saveConfig()` them at startup, permanently poisoning the project config of whatever
  directory facode ran in (e.g. a one-shot with `FACODE_API_KEY`/`FACODE_BASE_URL` set
  baked those values in and broke every later run there). Explicit user actions
  (`/provider`, `/model`) still persist intentionally.
- **Commander gotcha**: use `await program.parseAsync()` — plain `program.parse()` does not
  await async `.action` handlers, so action errors become unhandled rejections (raw Node
  crash dump instead of main()'s catch). Errors print via `err.message`; full stack only
  with `FACODE_DEBUG=1`.
- **Provider errors**: connection failures surface the nested undici root cause
  (`APIConnectionError.cause` → `TypeError("fetch failed")` → real `ECONNRESET` etc.); 401s
  print the endpoint + masked key + fix instructions. `scripts/mock-401-server.mjs` serves a
  local 401 to test this without touching real endpoints.
- **Named providers (v0.2)**: `resolveProviderOptions()` picks the active endpoint. Built-in
  presets: `openai`, `deepseek`, `pi`, `anthropic`, `ollama` — each is an OpenAI-compatible
  endpoint with its own API key env var (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `PI_API_KEY`,
  `ANTHROPIC_API_KEY`). Select one with `facode --provider <name>`, `FACODE_PROVIDER`, or
  `/provider <name>` at runtime (saves `activeProvider` to `.facode/config.json`). Add more
  via the `providers` map in config. **Important**: `activeProvider: "openai"` is treated as
  *not selected* — the resolver only honors it when it's a real preset choice, so a default
  `openai` value never hijacks a legacy custom-endpoint setup (OPENAI_BASE_URL etc.).
- The `openai` SDK streams via `client.chat.completions.create({ stream: true, tools })`.
- **Tool protocol invariant**: the assistant message carrying `tool_calls` MUST be pushed
  to history before the `role:"tool"` results, or providers return empty/confused answers.
- One-shot runs (`initialPrompt`) and non-TTY stdin cannot show permission prompts — the
  bare-mode gate only prompts when `stdin.isTTY`, otherwise write/exec is denied unless
  `--dangerously-skip-permissions` / `--permission-mode auto`.
- **CLI flags**: the prompt is a **positional argument**, not a flag. `-p`/`--prompt`
  runs a one-shot prompt; `--project` is long-form only (it used to be `-p`, which silently
  swallowed the prompt as the project path and then exited with no turn run — see below).
  Correct usage: `facode "your prompt"` or `facode -p "your prompt"`.
- **TUI rendering invariant (v0.3)**: completed transcript content MUST render through
  Ink's `<Static>` (`ChatTranscript` in `src/tui/chat-history.tsx`), never in the dynamic
  buffer. Rendering all messages dynamically re-rendered the whole transcript per streaming
  delta and per keystroke (`inputValue` used to be lifted into `TuiApp`), which garbled the
  display on Windows once transcripts exceeded the viewport. Split:
  `<Static>` transcript (banner first, flushed once) + `LiveTurn` (streaming text/spinner)
  + `InputBox` (owns its own value state; `isActive=false` while a permission prompt is
  open so keys don't bleed). Transcript replacement (`/clear`, `/compact`, session load)
  bumps `transcriptEpoch` in `app.tsx`, which remounts the `<Static>` tree (Static can only
  append; it cannot re-render flushed items). There is a regression test
  (`src/tui/tui.test.tsx`) that renders the components with mock TTY streams via
  `src/tui/ink-test-utils.tsx`.
- **Startup performance (v0.2 pass)** — measure, don't guess; profiled costs were:
  bin spawning tsx for live TS (~700ms), `@/tui/app` import (Ink+React ~560ms),
  `openai` SDK import (~265ms), and the blocking `mcp.startAll()` (~2.5s: spawn +
  initialize + list 207 tools) BEFORE the first prompt. Fixes:
  (1) `bin/facode.js` now prefers compiled `dist/index.js` and only falls back to tsx
  when dist is missing — **run `npm run build` after editing src**, or use `npm run dev`.
  (2) `src/index.ts` dynamic-imports the TUI only in interactive TTY mode (bare/one-shot
  never pay the Ink cost) and starts MCP **in the background**; `src/agent/loop.ts` accepts
  a tools getter resolved once per turn, so `mcp__rea__*` tools appear from turn 2 onward
  (first turn may still use `rea_call_tool`). (3) `src/tui/app.tsx` polls MCP readiness and
  updates the banner. (4) `src/agent/provider.ts` lazy-imports the `openai` SDK on first
  client creation. (5) `src/mcp.ts` memoizes `findGlobalReaEntry()` AND probes known
  paths (APPDATA / node dir) before spawning `npm root -g` — resolveReaCli no longer
  re-spawns npm on every REA tool call. (6) `McpManager.stopAll()` sets a `stopping`
  flag so a quick one-shot exit that races the background start doesn't spam
  `[MCP] Failed to start ...`. Measured: `--help` 1614ms → ~160ms; one-shot `/help`
  ~4.2s → ~260ms; TUI first paint no longer waits for MCP.

- **Provider/model management (v0.4)**: all provider/model mutations live in
  `src/provider-commands.ts` (shared by the CLI subcommands and slash commands).
  Each operation mutates ONE raw layer file (never the merged view), so saving a
  user-level provider never copies project values into ~/.facode and vice versa.
  `provider add` defaults to the **user** layer; `--scope project` targets
  `.facode/config.json`. `env:VARNAME`-style keys are normalized by `addProvider`
  into an `apiKeyEnv` reference (secret stays in the environment). Keys are always
  displayed via `maskKey()` (first 8 + ... + last 4). `testProvider` pings
  `${baseURL}/models`. A provider resolved with an empty model now fails fast in
  `getProviderOptions()` with "No model configured." + hints (only custom
  providers added without a model can hit this; built-ins all carry defaults).
- **Model discovery (v0.4.1)**: `fetchEndpointModels()` (shared by `provider test`,
  `provider models`, `model set --pick`) GETs `${baseURL}/models` — read-only, no chat
  quota. `:free`-suffixed ids (Token Harbor / OpenRouter convention) are grouped first.
  `facode provider models <name>` lists all; `facode model set --pick [provider]` is a
  numbered interactive chooser (TTY only, defaults to the active/resolved provider —
  including the zero-config openai preset with OPENAI_BASE_URL). `/model pick` inside the
  TUI must NOT prompt (Ink owns stdin) — it renders the plain list instead. The picker is
  strict: only numbers from the list or exact ids (typo protection; custom ids go through
  `model set <name>` directly).
- **Provider updates (v0.4.2)**: `updateProvider()` partially updates a custom
  provider in place — only passed fields change, omitted key/model/URL survive.
  CLI: `facode provider set <name> [--base-url|--api-key|--api-key-env|--model]`
  (no options → usage, exit 1). Slash: `/provider set <name> <baseURL> [apiKey]
  [model]` (positional like `/provider add`; omitting apiKey keeps the stored
  one). Built-in presets are refused ("built-in and cannot be modified" + hint
  to register under a new name); unknown names error listing what IS registered.
  Key rotation semantics: an `env:`/`--api-key-env` update stores an `apiKeyEnv`
  ref and clears the plaintext; a plaintext update clears any `apiKeyEnv`
  (presetApiKey prefers the env ref, so leaving both would strand the new key).
  `addProvider` gained `force?: boolean` — `provider add ... --force` overwrites;
  without it the refusal lists all three remediations (remove / provider set /
  add --force).
- **Interactive provider/model overlays (TUI)**: the flows that only existed as
  readline prompts now work *inside* the chat box — `interactiveAddProvider` /
  `pickModel` cannot run under Ink (Ink owns stdin), which is why `/model pick`
  used to just print a list. `/model pick` opens an arrow-key model chooser,
  `/provider use` with no name opens a provider picker, `/provider add` with no
  fields opens a guided form. Slash commands stay the single source of truth: the
  optional `CommandContext.tui` (`TuiHooks`) only *opens* an overlay, and the
  choice is fed back through `runSlash()` / `addProvider()` in `app.tsx`, so
  persistence has exactly one code path (`/provider use <name>`, `/model <name>`).
  Without `ctx.tui` (bare mode, non-TTY, CLI subcommands) every command keeps its
  text output — no behavior change, and `/model pick` still falls back to
  `listProviderModels` + a pointer at `facode model set --pick`.
  Pieces: `src/tui/select-list.tsx` (windowed list, reused by both pickers),
  `src/tui/model-picker.tsx` (uses the new `getModelChoices()` — free-first,
  pre-highlights the configured model), `src/tui/provider-form.tsx` (4 fields,
  `validateProviderForm()` reuses `validateProviderInput` for name/URL and adds the
  `env:VAR` checks), `providerChoices()` feeds the provider picker, and
  `resolveModelTarget()` is now shared by `pickModel` and `getModelChoices` so all
  pickers target the same endpoint. Gotchas: the input box must go
  `isActive={false}` whenever an overlay is open (otherwise ↑/↓/Enter are swallowed
  by the chat input); the form's transcript echo masks the key with `maskKey()` —
  the field itself is on screen while typing, so never echo the raw value.
- **setProvider is display-only (v0.4.2)**: the TUI and bare-mode `setProvider`
  callbacks used to re-save the MERGED config into the project layer — leaking
  user values (and real API keys) into `.facode/config.json` on every
  `/provider use`. Persistence lives solely in `useProvider`; the callbacks now
  only update React state/status. The TUI status line shows live `model` +
  `provider` segments, re-read from disk after every slash command (the banner
  remains a startup snapshot, Claude Code style).
- **Commander positional options gotcha (v0.4)**: by default, program-level options
  (`--model`, `--provider`, ...) are recognized ANYWHERE in the argv chain, so
  `facode provider add x --model m1` was silently swallowed by the root `--model`
  (the subcommand received no model). Root program now calls
  `.enablePositionalOptions()` — each command's options apply only at its own
  level. Verified against a minimal Commander repro (`scripts/debug-cmdr.mjs`).
- **Config deep-merge (v0.4)**: `loadConfig` shallow-spread used to let a project
  config that defines its own `providers` (or `mcpServers`/`subagents`) map hide
  ALL user-level entries — the map key was overwritten wholesale. `providers`,
  `mcpServers`, `subagents` now merge key-by-key across layers (later layer wins
  per key). Regression test in `src/config.test.ts`.

## Distribution / publishing (v0.3)
- **npm name is `facode-cli`** (the plain `facode` name on npm is permanently taken by an
  unrelated 2022 frame-animation package "ddmy/FACode"). The **bin command stays `facode`**.
- End users install with `npm install -g facode-cli`. Publish flow: `npm login` →
  `npm publish` (package.json has `prepublishOnly: build + test` and a `files` whitelist:
  bin, dist, README.md, LICENSE — tests and ink-test-utils are excluded from dist via
  tsconfig, so delete dist before releasing builds or stale outputs leak into the tarball).
- Version single-source: `src/index.ts` reads `package.json` via `createRequire` (works from
  src via tsx and from dist) and feeds Commander + the TUI banner — never hardcode versions.
- Before first publish, verify with `npm pack` + install the tarball into an isolated
  prefix (`npm i -g --prefix <dir> <tarball>`) and smoke-test `--version` and a one-shot.

## Files to wire up next
- [x] `rea-mcp` discovery (global rea-agents → node + scripts/rea.mjs, npx fallback).
- [x] REA tool schema emission (raw JSON Schema passthrough via `Tool.jsonSchema`).
- [x] `reverse-engineer` subagent system prompt (config.ts `defaultSubagents`) with REA skill guidelines.
- [x] Session persistence format (JSONL, appended after each turn with error tolerance).
- [x] Test harness for the agent loop (mock provider) and unit tests for slash commands / REA triage.
- [x] `Task` tool to let the main agent delegate to subagents (`src/tools/task.ts`).
- [x] Dynamic REA discovery tools (`rea_search_tools`, `rea_call_tool`, `rea_triage`).
- [x] TUI permission prompt component (`src/tui/permission-prompt.tsx`) with interactive [y/a/d/p] approvals and diff previews.
- [x] Claude Code style TUI banner — now part of the `<Static>` transcript (`src/tui/chat-history.tsx`, `BannerStatic`) so it flushes once and scrolls away with the conversation.
- [x] Claude Code style TUI input (`src/tui/input-box.tsx`) with Up/Down prompt history, Tab autocomplete, and cursor movement.
- [x] Claude Code style markdown chat history (`src/tui/chat-history.tsx`) with code blocks, tool status badges, and thinking blocks.
- [x] Claude Code style status line (`src/tui/status-line.tsx`) with animated braille spinner and mode badge.
- [x] Automatic project memory injection (`FACODE.md` / `CLAUDE.md`) into system prompt.
- [x] Enhanced slash commands (`/help`, `/doctor`, `/cost`, `/tokens`, `/memory`, `/review`, `/rea`, `/model`, `/permissions`, `/sessions`, `/compact`, `/clear`).
- [x] Optimized file tools (`Grep` skips node_modules and binary files; `Glob` normalized paths; `Edit` generates unified diffs).
- [x] Startup performance pass (dist-first bin entry, lazy Ink/openai imports, background MCP tool discovery with per-turn tool resolution, cached REA entry lookup).
- [x] TUI rendering fix: `<Static>` transcript + live turn area, input state localized to `InputBox`, epoch remount on transcript replacement, live REA status moved to the status line, legacy-conhost tip in the banner. Plus `npm link` so `facode` runs as a global command.
- [x] Config robustness pass: user-level `~/.facode/config.json` layer, zero-config `openai` preset honors `OPENAI_BASE_URL`, CLI/env overrides no longer persist into project configs, `parseAsync` error propagation, friendly 401/429/connection-error messages with root causes.
- [x] Packaging for npm as `facode-cli@0.3.0`: files whitelist, README.md + LICENSE, version-from-package.json, test exclusion from dist, prepublishOnly gate.
- [x] Provider/model management (v0.4.0): `facode provider add|list|use|test|remove` + `facode model set|show` subcommands, `/provider add|list|use|remove|test` + settable `/model` slash commands, interactive `provider add` prompts (TTY), `--api-key-env` secret references, masked key display, "No model configured" guard, loadConfig deep-merge for record fields, 92 tests.
- [x] Model discovery (v0.4.1): `facode provider models <name>` + `facode model set --pick [provider]` (interactive numbered chooser, free models first), `/provider models` + `/model pick` slash commands, shared `fetchEndpointModels()` (no chat-quota cost), verified live against Token Harbor (73 models, 4 free).
- [x] Provider updates (v0.4.2): `facode provider set <name>` (partial update of base URL / key / model, built-in refusal, env-ref rotation) + `provider add --force` overwrite, `/provider set` slash command, TUI+bare `setProvider` made display-only (fixes merged-config/keys leaking into project config), live model+provider segments in the TUI status line.
- [x] Interactive provider/model overlays in the TUI: arrow-key `/model pick` chooser, `/provider use` picker, guided `/provider add` form (Ink-native, since the readline prompts cannot run there), `CommandContext.tui` hooks, shared `resolveModelTarget()`, `getModelChoices()`, `providerChoices()`, plus component and end-to-end chat-box regression tests.
