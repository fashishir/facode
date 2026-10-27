import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { ensureDir, writeJSON, formatBytes } from "@/utils";
import {
  loadConfig,
  defaultSubagents,
  resolveProviderOptions,
} from "@/config";
import {
  addProvider,
  listProviderModels,
  listProviderSetups,
  removeProvider,
  setModel,
  showModel,
  testProvider,
  updateProvider,
  useProvider,
} from "@/provider-commands";
import { stdin } from "node:process";
import { listSessions, loadSession, createSession, compactSession } from "@/session/store";
import type { Message } from "@/agent/types";
import { execFileSync } from "node:child_process";

export interface SlashCommand {
  name: string;
  description: string;
  args: string;
  execute: (args: string, ctx: CommandContext) => Promise<string>;
}

/**
 * Interactive TUI hooks. Slash commands are shared by bare mode (where a string
 * is the only output) and the Ink TUI (where a command may need to open one of
 * its own overlays). When a hook is missing the command falls back to its text
 * output, so bare mode / non-TTY behavior is unchanged.
 */
export interface TuiHooks {
  /** Arrow-key chooser listing a registered provider's (or the active endpoint's) models. */
  openModelPicker: (provider?: string) => void;
  /** Arrow-key chooser listing registered providers, to switch the active one. */
  openProviderPicker: () => void;
  /** Guided `provider add` form, optionally prefilled with a name. */
  openProviderForm: (name?: string) => void;
}

export interface CommandContext {
  cwd: string;
  messages: Message[];
  setMessages: (msgs: Message[]) => void;
  setStatus: (s: string) => void;
  setPermissionMode: (mode: "default" | "plan" | "auto") => void;
  permissionMode: "default" | "plan" | "auto";
  setProvider: (name: string) => void;
  compact: () => Promise<void>;
  exit: () => void;
  /** Present only in the TUI — enables the interactive choosers. */
  tui?: TuiHooks;
}

const BUILTINS: SlashCommand[] = [
  {
    name: "help",
    description: "List all available slash commands and keyboard shortcuts",
    args: "",
    async execute(_args, _ctx) {
      const cmdList = BUILTINS.map(
        (c) => `  /${c.name.padEnd(12)} ${c.args.padEnd(18)} ${c.description}`
      ).join("\n");

      return [
        "──────────────── FA Code Commands ────────────────",
        cmdList,
        "",
        "─────────────── Keyboard Shortcuts ───────────────",
        "  Enter        Submit prompt",
        "  Shift+Enter  Add newline to prompt",
        "  Up / Down    Navigate command history",
        "  Tab          Autocomplete slash command",
        "  Ctrl+C       Interrupt active turn / cancel prompt",
        "  Esc          Clear prompt input",
        "───────────────────────────────────────────────────",
      ].join("\n");
    },
  },
  {
    name: "init",
    description: "Initialize project memory (FACODE.md / CLAUDE.md) and configuration",
    args: "",
    async execute(_args, ctx) {
      const cfg = loadConfig(ctx.cwd);
      ensureDir(resolve(ctx.cwd, ".facode"));
      const memoryPath = resolve(ctx.cwd, "FACODE.md");
      if (!existsSync(memoryPath)) {
        const template = [
          `# ${resolve(ctx.cwd).split(/[\\/]/).pop()} — Project Guidelines`,
          "",
          "## Build & Test Commands",
          "- Build: `npm run build`",
          "- Test: `npm test`",
          "",
          "## Code Architecture & Style",
          "- Language: TypeScript (ESM)",
          "- Keep edits minimal and focused.",
          "",
          "## Reverse Engineering Notes",
          "- Use REA tools (`rea_analyze`, `rea_decompile`, `rea_search_tools`, `rea_call_tool`)",
          "- Use Task(subagent='reverse-engineer') for deep investigations.",
          "",
        ].join("\n");
        writeFileSync(memoryPath, template, "utf8");
      }
      writeFileSync(resolve(ctx.cwd, ".facode", "config.json"), JSON.stringify(cfg, null, 2));
      return "Initialized .facode/ directory with config.json and FACODE.md.";
    },
  },
  {
    name: "compact",
    description: "Compact conversation history into a concise summary",
    args: "",
    async execute(_args, ctx) {
      ctx.setStatus("Compacting context...");
      await ctx.compact();
      return "Conversation context successfully compacted.";
    },
  },
  {
    name: "clear",
    description: "Clear current conversation history from the screen",
    args: "",
    async execute(_args, ctx) {
      ctx.setMessages([]);
      return "Conversation history cleared.";
    },
  },
  {
    name: "model",
    description: "Show current model, set one (/model <name>), or pick from the endpoint (/model pick)",
    args: "[model|pick]",
    async execute(args, ctx) {
      const name = args.trim();
      if (!name) {
        return [
          showModel(ctx.cwd),
          "",
          "Usage: /model <model-name>   (persists to ~/.facode/config.json)",
          "       /model pick           (choose from the endpoint's models, free first)",
        ].join("\n");
      }
      if (name === "pick") {
        // In the TUI the chooser is an Ink overlay (Ink owns stdin, so the
        // command must not prompt itself). Bare mode / non-TTY renders the
        // plain list and leaves picking to `facode model set --pick`.
        if (ctx.tui) {
          const cfg = loadConfig(ctx.cwd);
          ctx.tui.openModelPicker(
            cfg.activeProvider ??
              (cfg.provider && cfg.provider !== "openai" ? cfg.provider : undefined)
          );
          return "";
        }
        const cfg = loadConfig(ctx.cwd);
        const resolved = resolveProviderOptions(cfg);
        const target =
          cfg.activeProvider ??
          (cfg.provider && cfg.provider !== "openai" ? cfg.provider : undefined) ??
          resolved.provider ??
          "openai";
        if (target === "custom") {
          return "The active endpoint is a legacy custom config — use /model <model-name> directly.";
        }
        return listProviderModels(ctx.cwd, target);
      }
      return setModel(ctx.cwd, name, "user");
    },
  },
  {
    name: "permissions",
    description: "Show or set tool permission mode (default | plan | auto)",
    args: "[mode]",
    async execute(args, ctx) {
      const mode = args.trim().toLowerCase();
      if (mode === "default" || mode === "plan" || mode === "auto") {
        ctx.setPermissionMode(mode);
        ctx.setStatus(`Permission mode: ${mode}`);
        return `Permission mode set to "${mode}".`;
      }
      return [
        `Current permission mode: "${ctx.permissionMode}"`,
        "Available modes:",
        "  - default: Ask before executing write or shell tools",
        "  - plan: Read-only mode; write/exec tools are blocked",
        "  - auto: Bypass permission prompts automatically",
        "Usage: /permissions [default|plan|auto]",
      ].join("\n");
    },
  },
  {
    name: "provider",
    description: "Show, add, switch, test, update, or remove LLM providers",
    args: "[add|list|use|remove|test|models|set] ...",
    async execute(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [sub, ...rest] = parts;

      if (!sub || sub === "list") {
        return [
          listProviderSetups(ctx.cwd),
          "",
          "Usage: /provider add <name> <baseURL> <apiKey> [model]",
          "       /provider add                 (guided form, TUI only)",
          "       /provider use|remove|test|models <name>",
          "       /provider use                 (pick from a list, TUI only)",
          "       /provider set <name> <baseURL> [apiKey] [model]",
        ].join("\n");
      }

      switch (sub) {
        case "add": {
          // /provider add <name> <baseURL> <apiKey> [model]
          // `env:VARNAME` keys are normalized into apiKeyEnv refs by addProvider.
          const [name, baseURL, apiKey, ...model] = rest;
          // Missing fields in the TUI open the guided form instead of printing
          // usage — the readline prompts cannot run there (Ink owns stdin).
          if (ctx.tui && (!name || !baseURL)) {
            ctx.tui.openProviderForm(name);
            return "";
          }
          if (!name || !baseURL || (!apiKey && !stdin.isTTY)) {
            return "Usage: /provider add <name> <baseURL> <apiKey> [model]\n(omit apiKey in an interactive TTY to be prompted)";
          }
          return addProvider({
            name,
            baseURL,
            apiKey,
            model: model.join(" "),
            scope: "user",
            cwd: ctx.cwd,
          });
        }
        case "use": {
          const name = rest[0];
          if (!name) {
            if (ctx.tui) {
              ctx.tui.openProviderPicker();
              return "";
            }
            return "Usage: /provider use <name>";
          }
          const out = useProvider(ctx.cwd, name, "user");
          ctx.setProvider(name);
          return out;
        }
        case "remove": {
          const name = rest[0];
          if (!name) return "Usage: /provider remove <name>";
          return removeProvider(ctx.cwd, name, "user");
        }
        case "test": {
          const name = rest[0];
          if (!name) return "Usage: /provider test <name>";
          return testProvider(ctx.cwd, name);
        }
        case "models": {
          const name = rest[0];
          if (!name) return "Usage: /provider models <name>";
          return listProviderModels(ctx.cwd, name);
        }
        case "set": {
          // /provider set <name> <baseURL> [apiKey] [model] — partial update;
          // omitting apiKey keeps the stored key. `env:VAR` keys are
          // normalized into apiKeyEnv refs by updateProvider.
          const [name, baseURL, apiKey, ...model] = rest;
          if (!name || !baseURL) {
            return [
              "Usage: /provider set <name> <baseURL> [apiKey] [model]",
              "Pass the current baseURL again to change only the key.",
              "Built-ins (openai, deepseek, ...) cannot be modified.",
            ].join("\n");
          }
          return updateProvider({
            name,
            baseURL,
            apiKey,
            model: model.join(" ") || undefined,
            scope: "user",
            cwd: ctx.cwd,
          });
        }
        default: {
          // Back-compat: /provider <name> switches, like `/provider use <name>`.
          const out = useProvider(ctx.cwd, sub, "user");
          if (out.startsWith("✔")) ctx.setProvider(sub);
          return out;
        }
      }
    },
  },
  {
    name: "doctor",
    description: "Run comprehensive diagnostic check on Node, REA engines, and environment",
    args: "",
    async execute(_args, ctx) {
      const cfg = loadConfig(ctx.cwd);
      let reaOutput = "(REA CLI check failed)";
      try {
        const { resolveReaCli } = await import("@/mcp");
        const { command, args, shell } = resolveReaCli(["doctor"]);
        reaOutput = execFileSync(command, args, { encoding: "utf8", shell, timeout: 20000 });
      } catch (e: any) {
        reaOutput = [e?.stdout, e?.stderr, e?.message].filter(Boolean).join("\n") || "(doctor check failed)";
      }

      let gitStatus = "(not a git repository)";
      try {
        const branch = execFileSync("git", ["branch", "--show-current"], {
          cwd: ctx.cwd,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        gitStatus = branch ? `git branch: ${branch}` : "git: detached HEAD";
      } catch {}

      return [
        "═════════════════════ FA Code System Diagnostics ═════════════════════",
        `Runtime:      Node.js ${process.version}`,
        `Platform:     ${process.platform} (${process.arch})`,
        `Directory:    ${ctx.cwd}`,
        `Repository:   ${gitStatus}`,
        `AI Model:     ${cfg.model ?? "default"}`,
        `Permissions:  ${ctx.permissionMode}`,
        "",
        "──────────────────────── REA Engine Health ──────────────────────────",
        reaOutput.trim(),
        "═════════════════════════════════════════════════════════════════════",
      ].join("\n");
    },
  },
  {
    name: "cost",
    description: "Show conversation stats, message count, and estimated tokens",
    args: "",
    async execute(_args, ctx) {
      const msgs = ctx.messages;
      const userCount = msgs.filter((m) => m.role === "user").length;
      const assistantCount = msgs.filter((m) => m.role === "assistant").length;
      const toolCount = msgs.filter((m) => m.role === "tool").length;

      let totalChars = 0;
      for (const m of msgs) {
        totalChars += (typeof m.content === "string" ? m.content.length : 0);
      }
      const estimatedTokens = Math.round(totalChars / 4);

      return [
        "────────────── Conversation Statistics ──────────────",
        `Total messages:     ${msgs.length}`,
        `  User prompts:     ${userCount}`,
        `  Assistant turns:  ${assistantCount}`,
        `  Tool executions:  ${toolCount}`,
        `Transcript size:    ${formatBytes(totalChars)}`,
        `Estimated tokens:   ~${estimatedTokens.toLocaleString()}`,
        "─────────────────────────────────────────────────────",
      ].join("\n");
    },
  },
  {
    name: "tokens",
    description: "Alias for /cost",
    args: "",
    async execute(args, ctx) {
      return (await BUILTINS.find((c) => c.name === "cost")?.execute(args, ctx)) ?? "";
    },
  },
  {
    name: "memory",
    description: "View or show project memory file (FACODE.md / CLAUDE.md)",
    args: "",
    async execute(_args, ctx) {
      const candidates = ["FACODE.md", "CLAUDE.md", ".facode/FACODE.md"];
      for (const name of candidates) {
        const p = resolve(ctx.cwd, name);
        if (existsSync(p)) {
          const content = readFileSync(p, "utf8");
          return `Project Memory (${name}):\n\n${content}`;
        }
      }
      return "No memory file found. Run /init to create FACODE.md.";
    },
  },
  {
    name: "review",
    description: "Show git diff of uncommitted changes in current workspace",
    args: "",
    async execute(_args, ctx) {
      try {
        const diff = execFileSync("git", ["diff", "HEAD"], {
          cwd: ctx.cwd,
          encoding: "utf8",
          maxBuffer: 5 * 1024 * 1024,
          timeout: 10000,
        });
        if (!diff.trim()) return "Working tree is clean (no uncommitted changes).";
        return `\`\`\`diff\n${diff.slice(0, 10000)}\n\`\`\``;
      } catch (e: any) {
        return `Failed to read git diff: ${e?.message ?? e}`;
      }
    },
  },
  {
    name: "sessions",
    description: "List recent conversation sessions",
    args: "",
    async execute(_args, _ctx) {
      const sessions = listSessions();
      if (!sessions.length) return "No previous sessions found.";
      const lines = sessions
        .slice(0, 10)
        .map(
          (s) =>
            `  • ${s.id} (${s.updatedAt.slice(0, 16)}) - ${s.messageCount} messages`
        );
      return `Recent Sessions:\n${lines.join("\n")}\n\nResume with: facode -s <session-id>`;
    },
  },
  {
    name: "subagents",
    description: "List available specialized subagents",
    args: "",
    async execute(_args, ctx) {
      const cfg = loadConfig(ctx.cwd);
      const subs = { ...defaultSubagents(), ...(cfg.subagents ?? {}) };
      const lines = Object.entries(subs).map(
        ([name, s]) => `  • ${name.padEnd(18)} : ${s.description}`
      );
      return `Available Subagents (use via Task tool):\n${lines.join("\n")}`;
    },
  },
  {
    name: "rea",
    description: "Search or inspect REA reverse engineering tools",
    args: "[search <term> | triage <file>]",
    async execute(args, ctx) {
      const { getActiveMcpManager } = await import("@/mcp");
      const sub = args.trim();

      if (sub.startsWith("triage ")) {
        const target = sub.slice(7).trim();
        const { reaTriageTool } = await import("@/tools/rea");
        const res = await reaTriageTool.execute({ cwd: ctx.cwd, askPermission: async () => true }, { target });
        return res.output;
      }

      const mcp = getActiveMcpManager();
      if (!mcp) return "REA MCP server is not active.";

      if (sub.startsWith("search ")) {
        const q = sub.slice(7).trim();
        const matches = mcp.searchTools(q);
        if (!matches.length) return `No REA tools matching "${q}".`;
        const list = matches
          .slice(0, 20)
          .map((t) => `  * ${t.name}: ${t.description || "No description"}`)
          .join("\n");
        return `Found ${matches.length} REA tool(s) for "${q}":\n${list}`;
      }

      const tools = mcp.listMcpTools();
      return [
        `REA Engine: Active (${tools.length} reverse engineering MCP tools connected)`,
        "Commands:",
        "  /rea search <term>    Search REA tools by keyword (e.g. android, decompile, pe, frida)",
        "  /rea triage <file>    Classify artifact and recommend reverse engineering workflow",
      ].join("\n");
    },
  },
  {
    name: "exit",
    description: "Exit FA Code",
    args: "",
    async execute(_args, ctx) {
      ctx.exit();
      return "Exiting FA Code. Goodbye!";
    },
  },
];

export function getSlashCommands(): SlashCommand[] {
  return BUILTINS;
}

export async function findSlashCommand(name: string): Promise<SlashCommand | undefined> {
  const norm = name.toLowerCase();
  return BUILTINS.find((c) => c.name === norm);
}

export async function executeSlash(
  input: string,
  ctx: CommandContext
): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return "";
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0];
  const args = parts.slice(1).join(" ");
  const cmd = await findSlashCommand(name);
  if (!cmd) return `Unknown command: /${name}. Type /help for available commands.`;
  return cmd.execute(args, ctx);
}
