import { loadConfig } from "@/config";
import type { McpServerConfig } from "@/config";
import type { Tool } from "@/tools/types";
import { makeTool } from "@/tools/types";
import { z } from "zod";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Locate the globally installed `rea-agents` MCP entry (`scripts/rea.mjs`).
 * Cheap filesystem probes are tried before spawning `npm root -g` (a full npm
 * process costs 100ms+ and is synchronous here), and the result is memoized
 * so per-call CLI resolution (`resolveReaCli`) never re-spawns npm.
 * Spawning `node <entry> mcp` directly avoids the Windows `spawn npx ENOENT`
 * problem and the latency of npx resolution on every startup.
 */
let cachedReaEntry: string | undefined | null = null;
export function findGlobalReaEntry(): string | undefined {
  if (cachedReaEntry !== null) return cachedReaEntry;
  const candidates: string[] = [];
  if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, "npm", "node_modules", "rea-agents", "scripts", "rea.mjs")
    );
  }
  candidates.push(
    join(dirname(process.execPath), "node_modules", "rea-agents", "scripts", "rea.mjs")
  );
  let found = candidates.find((c) => {
    try {
      return existsSync(c);
    } catch {
      return false;
    }
  });
  if (!found) {
    // Fall back to querying npm only when the default locations miss.
    try {
      const root = execFileSync("npm", ["root", "-g"], {
        encoding: "utf8",
        timeout: 10_000,
      }).trim();
      if (root) {
        const probe = join(root, "rea-agents", "scripts", "rea.mjs");
        try {
          if (existsSync(probe)) found = probe;
        } catch {}
      }
    } catch {
      // npm not on PATH or slow — fall through.
    }
  }
  cachedReaEntry = found ?? undefined;
  return cachedReaEntry;
}

/**
 * Resolve a configured command for spawning.
 * On Windows, `npx`/`npm`/`rea` etc. are `.cmd` shims which Node cannot spawn
 * directly (ENOENT / EINVAL) — they must go through the shell.
 */
function resolveServerCommand(config: McpServerConfig): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const args = config.args ?? [];
  const cmd = config.command;
  if (process.platform !== "win32") {
    return { command: cmd, args, shell: false };
  }
  if (/\.(exe|cmd|bat)$/i.test(cmd)) {
    return { command: cmd, args, shell: /\.(cmd|bat)$/i.test(cmd) };
  }
  // Known JS-toolkit shims installed as .cmd by npm on Windows.
  if (/^(npx|npm|pnpm|yarn|rea|rea-agents)$/i.test(cmd)) {
    return { command: `${cmd}.cmd`, args, shell: true };
  }
  return { command: cmd, args, shell: false };
}

/** Default REA MCP server config: global rea-agents via node, npx fallback. */
export function defaultReaServerConfig(): McpServerConfig {
  const entry = findGlobalReaEntry();
  if (entry) {
    return { command: process.execPath, args: [entry, "mcp"], env: {} };
  }
  return process.platform === "win32"
    ? { command: "npx.cmd", args: ["-y", "rea-agents@6.7.0", "mcp"], env: {} }
    : { command: "npx", args: ["-y", "rea-agents@6.7.0", "mcp"], env: {} };
}

/**
 * Resolve a `rea <args>` CLI invocation. Prefers the global rea-agents entry
 * via node; falls back to the `rea` shim (Windows needs the .cmd shim + shell).
 */
export function resolveReaCli(args: string[]): {
  command: string;
  args: string[];
  shell: boolean;
} {
  const entry = findGlobalReaEntry();
  if (entry) {
    return { command: process.execPath, args: [entry, ...args], shell: false };
  }
  if (process.platform === "win32") {
    return { command: "rea.cmd", args, shell: true };
  }
  return { command: "rea", args, shell: false };
}

/**
 * Line-buffered JSON-RPC connection over a child process stdio.
 * Matches responses to requests by id, tolerates interleaved notifications
 * and non-JSON noise on stdout, and fails pending requests on exit/error.
 */
class RpcConnection {
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  closed = false;

  constructor(private proc: ChildProcess) {
    const stdout = proc.stdout;
    if (stdout) {
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => this.onData(chunk));
    }
    const failAll = (why: string) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      this.pending.clear();
    };
    proc.on("error", (err) => failAll(`MCP process error: ${err.message}`));
    proc.on("exit", (code) => failAll(`MCP process exited (code ${code ?? "?"})`));
    proc.stderr?.on("data", () => {
      /* server diagnostics — intentionally ignored */
    });
    proc.stdin?.on("error", () => {
      /* EPIPE when the server dies; request timeouts/failAll handle the rest */
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON banner output etc.
      }
      if (msg?.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      // Notifications / responses with unknown ids are dropped.
    }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error("MCP connection closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(payload);
    });
  }
}

interface ServerHandle {
  proc: ChildProcess;
  rpc: RpcConnection;
  tools: McpTool[];
}

/**
 * MCP Client - manages stdio connections to MCP servers.
 * The `rea-agents` package provides `rea-mcp` as an MCP server.
 */
export class McpManager {
  private servers = new Map<string, ServerHandle>();
  /** Set by stopAll() so a torn-down start loses the error spam. */
  private stopping = false;

  /** Start all configured MCP servers for the given project directory. */
  async startAll(cwd: string = process.cwd()): Promise<void> {
    const cfg = loadConfig(cwd);
    const servers: Record<string, McpServerConfig> = { ...cfg.mcpServers };

    // Ensure rea-mcp is available (from globally installed rea-agents)
    if (!servers.rea) {
      servers.rea = defaultReaServerConfig();
    }

    for (const [id, config] of Object.entries(servers)) {
      if (config.disabled) continue;
      try {
        await this.startServer(id, config);
      } catch (e: any) {
        if (!this.stopping) {
          console.error(`[MCP] Failed to start ${id}: ${e?.message ?? e}`);
        }
      }
    }
  }

  private async startServer(id: string, config: McpServerConfig): Promise<void> {
    const { command, args, shell } = resolveServerCommand(config);
    const proc = spawn(command, args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell,
    });

    const rpc = new RpcConnection(proc);
    const handle: ServerHandle = { proc, rpc, tools: [] };
    this.servers.set(id, handle);

    try {
      await rpc.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "facode", version: "0.1.0" },
        },
        30_000
      );
      rpc.request("notifications/initialized", {}, 5_000).catch(() => {});
      const result = await rpc.request("tools/list", {}, 30_000);
      handle.tools = (result?.tools ?? []) as McpTool[];
      console.log(`[MCP] ${id}: ${handle.tools.length} tools`);
    } catch (e) {
      this.servers.delete(id);
      try {
        proc.kill();
      } catch {}
      throw e;
    }
  }

  /** Get all MCP tools as FA Code Tool wrappers. */
  getTools(): Tool<any>[] {
    const tools: Tool<any>[] = [];
    for (const [serverId, handle] of this.servers) {
      for (const mt of handle.tools) {
        // Namespaced: mcp__rea__decompile
        const name = `mcp__${serverId}__${mt.name}`;
        const schema = this.zodFromSchema(mt.inputSchema);
        tools.push(
          makeTool({
            name,
            description: `[MCP:${serverId}] ${mt.description ?? mt.name}`,
            schema,
            jsonSchema: mt.inputSchema,
            permission: "read",
            async execute(_ctx, args) {
              try {
                const result = await handle.rpc.request(
                  "tools/call",
                  { name: mt.name, arguments: args },
                  600_000 // REA analysis can take minutes on large artifacts
                );
                if (result?.isError) {
                  const text = extractToolText(result);
                  return { output: text || "MCP tool reported an error", error: true };
                }
                return { output: extractToolText(result) };
              } catch (e: any) {
                return { output: `MCP tool error: ${e?.message ?? e}`, error: true };
              }
            },
          })
        );
      }
    }
    return tools;
  }

  /** Call an MCP tool on a server (defaults to 'rea'). */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    serverId = "rea"
  ): Promise<{ output: string; error?: boolean }> {
    const handle = this.servers.get(serverId);
    if (!handle) {
      return { output: `MCP server "${serverId}" not running`, error: true };
    }
    const rawName = name.replace(new RegExp(`^mcp__${serverId}__`), "");
    try {
      const result = await handle.rpc.request(
        "tools/call",
        { name: rawName, arguments: args },
        600_000
      );
      if (result?.isError) {
        const text = extractToolText(result);
        return { output: text || "MCP tool reported an error", error: true };
      }
      return { output: extractToolText(result) };
    } catch (e: any) {
      return { output: `MCP tool error: ${e?.message ?? e}`, error: true };
    }
  }

  /** Search MCP tools by name or description keyword. */
  searchTools(query: string, serverId = "rea"): McpTool[] {
    const handle = this.servers.get(serverId);
    if (!handle) return [];
    const q = query.toLowerCase();
    return handle.tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
    );
  }

  /** List all raw MCP tools for a server. */
  listMcpTools(serverId = "rea"): McpTool[] {
    return this.servers.get(serverId)?.tools ?? [];
  }

  private zodFromSchema(_s: Record<string, unknown>): z.ZodTypeAny {
    // MCP input schemas are passed through to the model as JSON Schema by the
    // provider; on the zod side we accept anything.
    return z.any() as z.ZodTypeAny;
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    for (const [, { proc }] of this.servers) {
      try {
        proc.kill();
      } catch {}
    }
    this.servers.clear();
  }
}

let globalMcpManager: McpManager | undefined;

export function setActiveMcpManager(mcp: McpManager): void {
  globalMcpManager = mcp;
}

export function getActiveMcpManager(): McpManager | undefined {
  return globalMcpManager;
}

/** Extract a readable string out of an MCP tools/call result. */
function extractToolText(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
