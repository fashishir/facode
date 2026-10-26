import { z } from "zod";
import { makeTool, type ToolContext, type ToolResult } from "@/tools/types";
import { truncate } from "@/utils";

const Args = z.object({
  command: z.string().describe("Shell command to execute"),
  description: z.string().optional().describe("Short description of what this does"),
  timeout: z.number().optional().describe("Timeout in ms (default 120000)"),
});

function pickShell(): string {
  if (process.platform === "win32") return process.env.ComSpec || "cmd.exe";
  return "bash";
}

export const bashTool = makeTool({
  name: "Bash",
  description:
    "Executes a shell command. Use for running scripts, git, builds, installs, or any CLI. Prefer dedicated tools over Bash when one fits.",
  schema: Args,
  permission: "exec",
  async execute(ctx: ToolContext, input: z.infer<typeof Args>): Promise<ToolResult> {
    const { execFileSync } = await import("node:child_process");
    const shell = pickShell();
    const args = process.platform === "win32" ? ["/c", input.command] : ["-c", input.command];
    const timeout = input.timeout ?? 120_000;
    try {
      const out = execFileSync(shell, args, {
        cwd: ctx.cwd,
        env: { ...process.env, FACODE: "1" },
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
      });
      return { output: truncate(out, 8000) };
    } catch (e: any) {
      const stderr = e?.stderr ?? "";
      const stdout = e?.stdout ?? "";
      const msg = [stdout, stderr, e?.message].filter(Boolean).join("\n");
      return { output: truncate(msg, 8000), error: true };
    }
  },
});

export type BashTool = typeof bashTool;