# FA Code (facode-cli)

**FA Code is a Claude Code–style CLI coding agent with [REA (Reverse Engineering Anything)](https://github.com/morluto/rea-agents) built in.**

It's an autonomous terminal agent for software engineering and binary analysis: streaming TUI, tool permission prompts, plan mode, sessions, context compaction, skills, subagents — and 200+ reverse-engineering tools (decompilers, disassemblers, APK/PE/Electron/JS analysis) exposed directly to the model.

## Install

Requires **Node.js ≥ 20**.

```bash
npm install -g facode-cli
```

Then run from any directory:

```bash
facode
```

## Quick start

```bash
# Interactive TUI (Claude Code style)
facode

# One-shot prompt
facode "explain the architecture of this repo"
facode -p "what is 2+2"

# Minimal UI (no Ink, plain text streaming)
facode --bare

# Pick a model / provider for this run (not persisted)
facode --provider deepseek --model deepseek-chat
```

> ⚠️ The prompt is a **positional argument**, not a flag: `facode "your prompt"`.
> Use `-p`/`--prompt` for an explicit one-shot run.

## Configuration

FA Code needs an **OpenAI-compatible** LLM endpoint. Configuration layers (later wins):

1. Built-in presets: `openai`, `deepseek`, `pi`, `anthropic`, `ollama`
2. User config: `~/.facode/config.json` — applies everywhere
3. Project config: `.facode/config.json` — applies in this project
4. Environment: `FACODE_API_KEY`, `FACODE_BASE_URL`, `FACODE_MODEL`, `FACODE_PROVIDER`
   (`OPENAI_API_KEY` / `OPENAI_BASE_URL` are honored by the `openai` preset)

### Providers & models

Register your own endpoints without editing JSON by hand:

```bash
# Register a custom provider (saved to ~/.facode/config.json — works everywhere)
facode provider add myproxy --base-url https://my.proxy/v1 --api-key sk-... --model my-model

# Or reference an environment variable instead of storing the key on disk
facode provider add myproxy --base-url https://my.proxy/v1 --api-key-env MY_PROXY_KEY

# Bare `facode provider add` (in a terminal) asks for everything interactively
facode provider add

facode provider list             # registered providers, masked keys, active marker
facode provider use myproxy      # switch active provider (persists)
facode provider test myproxy     # pings GET /models — verifies endpoint + key
facode provider remove myproxy

facode model set my-model        # set + persist the model
facode model show                # resolved model / provider / base URL
```

Add `--scope project` to any of the above to write the project's
`.facode/config.json` instead of the user config.

Minimal user config example (`~/.facode/config.json`):

```json
{
  "model": "gpt-4o"
}
```

With `OPENAI_API_KEY` in your environment, that's enough to work from any directory.

Switch providers at runtime with `/provider <name>` or per run with
`facode --provider <name>`. You can also manage providers from inside the TUI:
`/provider add <name> <baseURL> <apiKey> [model]`, `/provider list|use|remove|test`,
and `/model <name>` to set one. The `providers` map in a config file works too:

```json
{
  "providers": {
    "myproxy": { "baseURL": "https://my.proxy/v1", "apiKey": "sk-...", "model": "my-model" }
  },
  "activeProvider": "myproxy"
}
```

## What it can do

- **Code**: read/edit/write files, glob, grep, run shell commands — with a
  permission gate (`default` = ask every time, `plan` = approve writes, `auto` =
  no prompts) and `--dangerously-skip-permissions` if you insist.
- **Reverse engineering (REA)**: classify an artifact (`rea_triage`), decompile
  (`rea_decompile`), analyze apps/bundles (`rea_analyze`), and call any of the
  200+ REA tools (`rea_search_tools`, `rea_call_tool`). Analysis engines
  (Hopper, Ghidra, IDA, jadx) are optional — install what you have, REA falls
  back to available ones.
- **Subagents**: a `reverse-engineer` specialist and read-only `explore` agent
  the main agent can delegate to via the `Task` tool.
- **Sessions & memory**: JSONL session history, `/compact` context
  summarization, and automatic project memory injection from `FACODE.md` /
  `CLAUDE.md`.

## Slash commands

`/help`, `/doctor`, `/cost`, `/tokens`, `/memory`, `/review`, `/rea`,
`/model`, `/provider`, `/permissions`, `/sessions`, `/compact`, `/clear`

## Development

```bash
git clone <your-fork> facode && cd facode
npm install
npm run build   # compile dist (bin prefers dist, falls back to tsx)
npm test        # vitest suite
npm link        # register `facode` globally from the working tree
```

## License

MIT
