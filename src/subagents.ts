import { loadConfig, defaultSubagents } from "@/config";
import type { SubagentConfig } from "@/config";
import type { Tool } from "@/tools/types";
import { runAgentLoop } from "@/agent/loop";
import type { Message } from "@/agent/types";

export interface SubagentResult {
  name: string;
  output: string;
  messages: Message[];
}

/**
 * Subagent registry. The `reverse-engineer` subagent is the REA integration point:
 * it runs a nested agent loop with REA tools and a specialized prompt.
 */
export class SubagentRegistry {
  private configs: Record<string, SubagentConfig>;

  constructor(cwd: string) {
    const cfg = loadConfig(cwd);
    this.configs = { ...defaultSubagents(), ...(cfg.subagents ?? {}) };
  }

  list(): string[] {
    return Object.keys(this.configs);
  }

  get(name: string): SubagentConfig | undefined {
    return this.configs[name];
  }

  /** Run a subagent with a task and available tools. */
  async run(
    name: string,
    task: string,
    tools: Tool<any>[],
    opts: {
      cwd: string;
      permissionGate: (tool: string, input: unknown, level: string) => Promise<boolean>;
      onDelta?: (delta: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<SubagentResult> {
    const cfg = this.configs[name];
    if (!cfg) throw new Error(`Unknown subagent: ${name}`);

    const allowed = cfg.tools
      ? tools.filter((t) => cfg.tools!.some((p) => p === t.name || (p.endsWith("*") && t.name.startsWith(p.slice(0, -1)))))
      : tools;

    const { messages } = await runAgentLoop(task, [], {
      cwd: opts.cwd,
      systemPrompt: cfg.prompt,
      tools: allowed,
      permissionGate: opts.permissionGate,
      onDelta: opts.onDelta,
      signal: opts.signal,
    });

    const last = messages[messages.length - 1]?.content ?? "";
    return { name, output: typeof last === "string" ? last : "", messages };
  }
}

/** Convenience: run the reverse-engineer subagent on a target. */
export async function runReaSubagent(
  task: string,
  tools: Tool<any>[],
  opts: {
    cwd: string;
    permissionGate: (tool: string, input: unknown, level: string) => Promise<boolean>;
    onDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }
): Promise<SubagentResult> {
  const reg = new SubagentRegistry(opts.cwd);
  return reg.run("reverse-engineer", task, tools, opts);
}