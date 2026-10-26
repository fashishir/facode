import { z } from "zod";
import { makeTool, type ToolContext, type ToolResult } from "@/tools/types";
import { SubagentRegistry } from "@/subagents";
import { ToolRegistry } from "@/tools/registry";
import { getActiveMcpManager } from "@/mcp";

const Args = z.object({
  subagent: z
    .string()
    .describe("Name of the subagent to run ('reverse-engineer' or 'explore')"),
  prompt: z
    .string()
    .describe("The specific task description, target, question, and instructions for the subagent"),
});

export const taskTool = makeTool({
  name: "Task",
  description:
    "Launch a specialized subagent for complex, deep, or multi-step tasks. Use 'reverse-engineer' for deep reverse engineering of binaries, bundles, APKs, or protocols; use 'explore' for fast read-only codebase search.",
  schema: Args,
  permission: "read",
  async execute(ctx: ToolContext, input: z.infer<typeof Args>): Promise<ToolResult> {
    try {
      const reg = new SubagentRegistry(ctx.cwd);
      const mcp = getActiveMcpManager();
      const mcpTools = mcp ? mcp.getTools() : [];
      const baseRegistry = new ToolRegistry();
      const allTools = [...baseRegistry.list(), ...mcpTools];

      const res = await reg.run(input.subagent, input.prompt, allTools, {
        cwd: ctx.cwd,
        permissionGate: async () => true,
      });

      return {
        output: res.output || `Subagent ${input.subagent} completed without text output.`,
      };
    } catch (e: any) {
      return {
        output: `Subagent "${input.subagent}" failed: ${e?.message ?? e}`,
        error: true,
      };
    }
  },
});

export type TaskTool = typeof taskTool;
