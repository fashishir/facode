#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { Chalk } from "chalk";
const chalk = new Chalk({ level: 2 });
import { loadConfig, defaultSystemPrompt } from "@/config";
import { ensureDir, facodeDir } from "@/utils";
import { createSession, loadSession, appendSession, compactSession } from "@/session/store";
import { runAgentLoop } from "@/agent/loop";
import { getProviderOptions } from "@/agent/provider";
import { summarizeMessages } from "@/agent/compaction";
import { McpManager, setActiveMcpManager } from "@/mcp";
import { ToolRegistry } from "@/tools/registry";
import type { Tool } from "@/tools/types";
import { loadPermissions, decide, savePermissions } from "@/permissions";
import { executeSlash } from "@/cli";
import {
  addProvider,
  interactiveAddProvider,
  listProviderModels,
  listProviderSetups,
  pickModel,
  removeProvider,
  setModel,
  setFailover,
  showFailover,
  showModel,
  testProvider,
  updateProvider,
  useProvider,
  type Scope,
} from "@/provider-commands";
import type { Message } from "@/agent/types";

// Single source of truth for the version: package.json (resolved relative to
// this module, so it works from src via tsx and from the compiled dist).
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const VERSION = pkg.version;

interface CliOptions {
  project?: string;
  prompt?: string;
  session?: string;
  model?: string;
  provider?: string;
  permissionMode?: string;
  allowedTools?: string;
  dangerouslySkipPermissions?: boolean;
  bare?: boolean;
}

async function main() {
  const program = new Command();
  program
    .name("facode")
    // Without this, program-level options (--model, --provider, ...) are
    // recognized ANYWHERE in the argv chain — the root --model would swallow
    // `facode provider add x --model m1` before the subcommand sees it.
    .enablePositionalOptions()
    .description("FA Code – a Claude Code style CLI agent with REA engine")
    .version(VERSION)
    .option("--project <path>", "Project directory", process.cwd())
    .option("-p, --prompt <prompt>", "Initial prompt to run (one-shot)")
    .option("-s, --session <id>", "Resume session ID")
    .option("--model <name>", "Override model")
    .option("--provider <name>", "Active LLM provider (openai|deepseek|pi|anthropic|ollama)")
    .option("--permission-mode <mode>", "default|plan|auto", "default")
    .option("--allowed-tools <list>", "Comma-separated tool names (or '*')")
    .option("--dangerously-skip-permissions", "Bypass all prompts")
    .option("--bare", "Minimal UI (plain text, no Ink)")
    .argument("[prompt]", "Initial prompt")
    .action(async (prompt: string | undefined, opts: CliOptions = {}) => {
      const cwd = resolve(opts.project ?? process.cwd());
      const initialPrompt = prompt ?? opts.prompt;
      ensureDir(facodeDir(cwd));

      // Apply CLI overrides IN MEMORY only — they must not persist into
      // .facode/config.json, or a one-shot run with --model/FACODE_* env set
      // would permanently poison the project config (baseURL/apiKey/model
      // baked in for all future runs). Explicit user actions (/provider,
      // /model) save on their own.
      const cfg = loadConfig(cwd);
      if (opts.model) cfg.model = opts.model;
      if (opts.provider) cfg.activeProvider = opts.provider as any;
      if (opts.permissionMode) cfg.permissionMode = opts.permissionMode as any;
      if (opts.dangerouslySkipPermissions) cfg.permissionMode = "auto";

      // Start MCP (REA) in the background — it takes ~2.5s to connect and
      // list 207 tools, so don't block first paint. The tool list is resolved
      // per turn, so REA tools appear as soon as the server is ready.
      const mcp = new McpManager();
      mcp.startAll(cwd).catch(() => {
        // Tolerated if MCP server is not available
      });
      setActiveMcpManager(mcp);

      // Merge builtin + MCP tools, resolved per turn so a still-connecting
      // MCP server contributes its tools from the next turn onwards.
      const registry = new ToolRegistry();
      const allowed = opts.allowedTools
        ? opts.allowedTools.split(",").map((s: string) => s.trim())
        : undefined;
      const getTools = (): Tool<any>[] => {
        const mcpTools = mcp.getTools();
        const base = allowed ? registry.filter(allowed) : registry.list();
        const mcpFiltered = allowed
          ? allowed.includes("*")
            ? mcpTools
            : mcpTools.filter((t) => allowed.includes(t.name))
          : mcpTools;
        return [...base, ...mcpFiltered];
      };

      // Permissions
      const permState = loadPermissions(cwd);
      const skipPermissions = !!opts.dangerouslySkipPermissions;
      let askFn:
        | ((tool: string, level: string, preview: string) => Promise<boolean>)
        | undefined;
      const permissionGate = async (tool: string, userInput: unknown, level: string) => {
        if (skipPermissions) return true;
        if (decide(permState, tool, level as "read" | "write" | "exec" | "none")) return true;
        if (!askFn) return false;
        const preview =
          typeof userInput === "object" && userInput !== null
            ? JSON.stringify(userInput).slice(0, 300)
            : String(userInput ?? "");
        const ok = await askFn(tool, level, preview);
        if (ok) permState.alwaysAllow.add(tool);
        return ok;
      };

      // Session handling
      let sessionId = opts.session;
      let history: Message[] = [];
      if (sessionId) {
        history = loadSession(sessionId);
      } else {
        sessionId = createSession(cwd);
      }

      let persisted = history.length;
      const persistNew = (msgs: Message[]) => {
        for (let i = persisted; i < msgs.length; i++) {
          appendSession(sessionId!, msgs[i], { cwd });
        }
        persisted = msgs.length;
      };

      const cleanup = async () => {
        try {
          await mcp.stopAll();
        } catch {}
      };

      process.on("exit", () => {
        cleanup();
      });

      if (opts.bare || !output.isTTY) {
        try {
          await runBareLoop({
            cwd,
            sessionId,
            history,
            initialPrompt,
            tools: getTools,
            permissionGate,
            getProviderOptions: () => getProviderOptions(cwd),
            mcp,
            permState,
            setAskFn: (fn) => (askFn = fn),
            persistNew,
            getHistory: () => history,
            setHistory: (h) => {
              history = h;
              persisted = h.length;
            },
          });
        } finally {
          await cleanup();
        }
      } else {
        // Ink + React cost ~560ms to import — only pay it in interactive TTY
        // mode, never for bare/one-shot/non-TTY runs.
        const { runTuiApp } = await import("@/tui/app");
        try {
          await runTuiApp({
            cwd,
            sessionId,
            history,
            initialPrompt,
            version: VERSION,
            tools: getTools,
            permissionGate: skipPermissions ? async () => true : undefined,
            getProviderOptions: () => getProviderOptions(cwd),
            provider: cfg.activeProvider ?? cfg.provider ?? "openai",
            mcp,
            persistNew,
            getHistory: () => history,
            setHistory: (h) => {
              history = h;
              persisted = h.length;
            },
          });
        } finally {
          await cleanup();
        }
      }
    });

  // ── provider/model management subcommands ────────────────────────────────
  // NOTE: these must be registered on the root program. Commander matches
  // subcommand names before the positional [prompt] argument, so
  // `facode provider list` routes here while `facode "explain this repo"`
  // still reaches the default action as a prompt.
  const projectCwd = () => resolve(program.opts<CliOptions>().project ?? process.cwd());
  const scopeOf = (opts: { scope?: string }): Scope => {
    const s = (opts.scope ?? "user").toLowerCase();
    if (s !== "user" && s !== "project") {
      throw new Error(`Invalid --scope "${s}" — use "user" or "project".`);
    }
    return s;
  };

  const providerCmd = program
    .command("provider")
    .description("Manage LLM providers (add, list, use, test, remove)")
    .action(() => providerCmd.help());

  providerCmd
    .command("add [name]")
    .description("Register a custom OpenAI-compatible provider (saved to user config by default)")
    .option("--base-url <url>", "OpenAI-compatible base URL, e.g. https://api.example.com/v1")
    .option("--api-key <key>", "API key (plaintext; prefer --api-key-env)")
    .option("--api-key-env <name>", "Name of an environment variable holding the API key")
    .option("--model <model>", "Default model for this provider")
    .option("--scope <scope>", "Where to save: user (~/.facode) or project (.facode)")
    .option("--force", "Overwrite the provider if it already exists in the target scope")
    .action(async (name: string | undefined, opts: { baseUrl?: string; apiKey?: string; apiKeyEnv?: string; model?: string; scope?: string; force?: boolean }) => {
      const scope = scopeOf(opts);
      const cwd = projectCwd();
      // Treat --api-key-env as an env:-style key so both the direct and the
      // interactive path store an apiKeyEnv reference, not a copy.
      const apiKey = opts.apiKeyEnv ? `env:${opts.apiKeyEnv}` : opts.apiKey;
      if (name && opts.baseUrl && apiKey) {
        console.log(addProvider({ name, baseURL: opts.baseUrl, apiKey, model: opts.model, scope, cwd, force: opts.force }));
        return;
      }
      if (!input.isTTY) {
        console.log(
          [
            "provider add needs --base-url and a key when not interactive:",
            "  facode provider add <name> --base-url <url> --api-key <key> [--model <m>]",
            "  facode provider add <name> --base-url <url> --api-key-env <VAR> [--model <m>]",
          ].join("\n")
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        await interactiveAddProvider({
          name,
          baseURL: opts.baseUrl,
          apiKey,
          scope,
          cwd,
        })
      );
    });

  providerCmd
    .command("list")
    .description("List registered providers (keys masked, active marked)")
    .action(() => console.log(listProviderSetups(projectCwd())));

  providerCmd
    .command("use <name>")
    .description("Set the active provider (persists; --scope project for per-project)")
    .option("--scope <scope>", "Where to save: user or project")
    .action((name: string, opts: { scope?: string }) =>
      console.log(useProvider(projectCwd(), name, scopeOf(opts)))
    );

  providerCmd
    .command("remove <name>")
    .description("Remove a custom provider (built-ins cannot be removed)")
    .option("--scope <scope>", "Where to remove from: user or project")
    .action((name: string, opts: { scope?: string }) =>
      console.log(removeProvider(projectCwd(), name, scopeOf(opts)))
    );

  providerCmd
    .command("test <name>")
    .description("Ping the provider's /models endpoint to verify URL + key")
    .action(async (name: string) => console.log(await testProvider(projectCwd(), name)));

  providerCmd
    .command("models <name>")
    .description("List all models the provider's endpoint offers (free models first)")
    .action(async (name: string) => console.log(await listProviderModels(projectCwd(), name)));

  // Auto-failover: when the active model hits a quota/rate-limit error, FA Code
  // silently switches to another model on the same endpoint and retries, so a
  // free-tier cap never kills a session. The switch is in-memory for the turn
  // only — the configured model is untouched, so a fresh session starts clean.
  const failoverCmd = program
    .command("failover")
    .description("Show or set the auto-failover policy (quota/rate-limit fallback)");
  failoverCmd
    .command("show")
    .description("Show the effective failover policy")
    .action(() => console.log(showFailover(projectCwd())));
  failoverCmd
    .command("on")
    .description("Turn auto-failover on")
    .option("--free-only", "Only fall back to :free models (never spends paid quota)")
    .option("--max-attempts <n>", "Max models to try per turn", "3")
    .option("--scope <scope>", "Where to save: user or project", "user")
    .action((opts: { freeOnly?: boolean; maxAttempts?: string; scope?: string }) =>
      console.log(
        setFailover(
          { enabled: true, freeOnly: opts.freeOnly, maxAttempts: parseInt(opts.maxAttempts ?? "3", 10) || 3 },
          scopeOf(opts),
          projectCwd()
        )
      )
    );
  failoverCmd
    .command("off")
    .description("Turn auto-failover off (quota errors propagate to the user)")
    .option("--scope <scope>", "Where to save: user or project", "user")
    .action((opts: { scope?: string }) =>
      console.log(setFailover({ enabled: false }, scopeOf(opts), projectCwd()))
    );

  providerCmd
    .command("set <name>")
    .description("Update an existing provider — only the options you pass change")
    .option("--base-url <url>", "New base URL")
    .option("--api-key <key>", "New API key (plaintext; prefer --api-key-env)")
    .option("--api-key-env <name>", "New env-var reference for the API key")
    .option("--model <model>", "New default model")
    .option("--scope <scope>", "Which layer to update: user or project")
    .action((name: string, opts: { baseUrl?: string; apiKey?: string; apiKeyEnv?: string; model?: string; scope?: string }) => {
      if (!opts.baseUrl && !opts.apiKey && !opts.apiKeyEnv && !opts.model) {
        console.log(
          [
            "Usage: facode provider set <name> [--base-url <url>] [--api-key <key>]",
            "       [--api-key-env <VAR>] [--model <m>] [--scope user|project]",
            "Everything you omit keeps its current value. Built-ins cannot be modified.",
          ].join("\n")
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        updateProvider({
          name,
          baseURL: opts.baseUrl,
          apiKey: opts.apiKey,
          apiKeyEnv: opts.apiKeyEnv,
          model: opts.model,
          scope: scopeOf(opts),
          cwd: projectCwd(),
        })
      );
    });

  const modelCmd = program
    .command("model")
    .description("Show or set the active model")
    .action(() => console.log(showModel(projectCwd())));

  modelCmd
    .command("set [model]")
    .description("Set + persist the model, or --pick it interactively from the endpoint")
    .option("--pick [provider]", "Fetch the model list and choose interactively (terminal only); optional provider name, defaults to the active provider")
    .option("--scope <scope>", "Where to save: user or project")
    .action(async (model: string | undefined, opts: { pick?: string | boolean; scope?: string }) => {
      const scope = scopeOf(opts);
      const cwd = projectCwd();
      if (opts.pick) {
        console.log(await pickModel(cwd, opts.pick === true ? undefined : opts.pick, scope));
        return;
      }
      if (!model) {
        console.log("Usage: facode model set <model> [--scope user|project]\n       facode model set --pick [provider]  (interactive chooser)");
        process.exitCode = 1;
        return;
      }
      console.log(setModel(cwd, model, scope));
    });

  modelCmd
    .command("show")
    .description("Show the resolved model, provider, and base URL")
    .action(() => console.log(showModel(projectCwd())));

  // parseAsync (not parse) so errors thrown inside the async .action handler
  // propagate to main()'s catch and print as a clean message. With parse(),
  // action rejections become unhandled promise rejections (raw Node crash).
  await program.parseAsync(process.argv);
}

interface RunOpts {
  cwd: string;
  sessionId: string;
  history: Message[];
  initialPrompt?: string;
  /** Tools available to the agent, or a getter resolved once per turn. */
  tools?: any[] | (() => any[]);
  permissionGate: (tool: string, input: unknown, level: string) => Promise<boolean>;
  getProviderOptions: () => any;
  mcp: McpManager;
  permState: ReturnType<typeof loadPermissions>;
  setAskFn: (fn: (tool: string, level: string, preview: string) => Promise<boolean>) => void;
  persistNew: (msgs: Message[]) => void;
  getHistory: () => Message[];
  setHistory: (msgs: Message[]) => void;
}

async function runBareLoop(opts: RunOpts): Promise<void> {
  const rl = createInterface({ input, output });
  const print = (txt: string) => output.write(txt + "\n");

  if (input.isTTY) {
    opts.setAskFn(async (tool, level, preview) => {
      print(chalk.yellow(`\n⚠️  Permission needed: ${tool} (${level})`));
      if (preview) print(chalk.dim(`  ${preview}`));
      const ans = await new Promise<string>((res) => {
        rl.question(
          chalk.yellow(`Allow? [y/N/a=always allow ${tool}] `),
          res
        );
      });
      const a = ans.trim().toLowerCase();
      if (a === "a") {
        opts.permState.alwaysAllow.add(tool);
        savePermissions(opts.cwd, opts.permState);
        return true;
      }
      return a === "y" || a === "yes";
    });
  }

  const slashContext = () => ({
    cwd: opts.cwd,
    messages: opts.getHistory(),
    setMessages: (m: Message[]) => opts.setHistory(m),
    setStatus: () => {},
    setPermissionMode: () => {},
    setProvider: (_name: string) => {
      // Display-only. Persistence already happened in useProvider
      // (provider-commands) with the correct per-layer write. This callback
      // used to save the MERGED config into the project layer — leaking user
      // values (and API keys) into .facode/config.json.
    },
    permissionMode: "default" as const,
    compact: async () => {
      await compactSession(opts.sessionId, 6, (msgs) => summarizeMessages(msgs, opts.cwd));
      opts.setHistory(loadSession(opts.sessionId));
    },
    exit: () => process.exit(0),
  });

  const runTurn = async (userInput: string) => {
    const { messages } = await runAgentLoop(userInput, opts.getHistory(), {
      cwd: opts.cwd,
      systemPrompt: defaultSystemPrompt(opts.cwd),
      tools: opts.tools,
      permissionGate: opts.permissionGate,
      onDelta: (delta) => {
        output.write(delta);
      },
      onToolCall: (call) => {
        print(chalk.cyan(`\n● Running ${call.function?.name ?? "tool"}...`));
      },
      onToolResult: (tool, res) => {
        if (res.error) {
          print(chalk.red(`✖ ${tool} error: ${res.output.slice(0, 200)}`));
        } else {
          print(chalk.green(`✔ ${tool} completed`));
        }
      },
      onTurnEnd: (msgs) => {
        opts.persistNew(msgs);
        opts.setHistory(msgs);
      },
    });
    print("");
  };

  if (opts.initialPrompt) {
    if (opts.initialPrompt.startsWith("/")) {
      try {
        const out = await executeSlash(opts.initialPrompt, slashContext());
        if (out) print(out);
      } catch (e: any) {
        print(chalk.red(`Error: ${e?.message ?? e}`));
      }
    } else {
      print(chalk.cyan(`❯ ${opts.initialPrompt}`));
      await runTurn(opts.initialPrompt);
    }
    await opts.mcp.stopAll();
    rl.close();
    return;
  }

  print(chalk.cyan.bold("FA Code") + chalk.gray(" (Claude Code CLI with REA). Type your prompt or /help."));
  let busy = false;
  const handleLine = async (line: string) => {
    if (line.startsWith("/")) {
      try {
        const out = await executeSlash(line, slashContext());
        if (out) print(out);
      } catch (e: any) {
        print(chalk.red(`Error: ${e?.message ?? e}`));
      }
      return;
    }
    print(chalk.cyan(`❯ ${line}`));
    await runTurn(line);
  };

  if (!input.isTTY) {
    const lines: string[] = [];
    rl.on("line", (l) => lines.push(l));
    rl.on("close", async () => {
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          await handleLine(l);
        } catch (e: any) {
          print(chalk.red(`Error: ${e?.message ?? e}`));
        }
      }
      await opts.mcp.stopAll();
      process.exit(0);
    });
    return;
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (line.startsWith("/")) {
      handleLine(line).catch((e: any) => print(chalk.red(`Error: ${e?.message ?? e}`)));
      return;
    }
    if (busy) {
      print(chalk.dim("(busy — waiting for current turn to complete)"));
      return;
    }
    busy = true;
    (async () => {
      try {
        await handleLine(line);
      } catch (e: any) {
        print(chalk.red(`Error: ${e?.message ?? e}`));
      } finally {
        busy = false;
      }
    })();
  });
  rl.on("close", () => process.exit(0));
}

main().catch((err: any) => {
  // Print API/config errors as a clean message, not a raw stack dump; the
  // full stack is still available via FACODE_DEBUG=1.
  if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  if (process.env.FACODE_DEBUG && err instanceof Error) {
    console.error(err.stack);
  }
  process.exit(1);
});
