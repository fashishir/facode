# Changelog

All notable changes to `facode-cli` are documented here.

## 0.4.2 — 2026-10-27

### Added

- `facode provider set <name>` — partial in-place updates: pass only the fields
  you want to change (`--base-url`, `--api-key`, `--api-key-env`, `--model`).
  The stored key is kept when you omit it.
- `facode provider add --force` — registering a name that already exists is
  refused by default; `--force` overwrites it explicitly.
- Interactive TUI overlays (arrow keys, no readline prompts):
  - `/model pick` opens a model chooser for the active provider.
  - `/provider use` with no name opens a provider picker.
  - `/provider add` with no fields opens a guided form (name, base URL, key,
    model) with per-field validation and `env:VARNAME` key references.
- Shared `SelectList` component and `ModelPicker` / `ProviderForm` hooks
  (`TuiHooks` on the slash-command context) so commands can open overlays while
  bare mode and non-TTY runs keep their plain-text output.
- `resolveModelTarget`, `getModelChoices`, and `providerChoices` helpers for
  resolving the active provider/model and listing endpoint models.

### Changed

- `npm pack` now builds `dist` through `prepack`, so a tarball can no longer be
  produced from stale compiled output. Tests run via `prepublishOnly`.
- README documents the TUI choosers and drops the outdated "CLI-only" note.
- `package.json` gains `repository`, `homepage`, and `bugs` metadata.
- Added `CHANGELOG.md` to the published files.

### Tests

- 146 tests across 10 files, including coverage for provider `set` / `--force`
  and the three TUI overlays.

## 0.4.1 — 2026-10-26

### Added

- Provider management: `facode provider add|list|use|remove|test|models`.
- Guided `facode provider add` prompts in an interactive terminal, plus
  `--api-key-env` to reference a key instead of storing it on disk.
- `facode provider models <name>` lists every model the endpoint offers, with
  `:free` models grouped first — no chat-quota cost.
- `facode model set --pick [provider]` numbered interactive model chooser, and
  `facode model set|show` for non-interactive use.
- `--scope project` on provider/model commands to write `.facode/config.json`
  instead of the user config.
- TUI slash commands `/provider` and `/model pick` (text listing).

## 0.4.0 — 2026-10-26

### Added

- Initial public release: Claude Code–style terminal agent with a streaming Ink
  TUI, tool-calling agent loop, permission modes (`default`, `plan`, `auto`),
  sessions, context compaction, project memory, subagents, and MCP support.
- REA (Reverse Engineering Anything) integration: `rea_triage`,
  `rea_decompile`, `rea_analyze`, `rea_search_tools`, `rea_call_tool`, plus a
  `reverse-engineer` subagent.
- OpenAI-compatible provider layer with built-in presets (`openai`, `deepseek`,
  `pi`, `anthropic`, `ollama`), layered config (user, project, environment), and
  a `--bare` plain-text mode.
