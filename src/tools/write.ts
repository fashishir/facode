import { z } from "zod";
import { makeTool, type ToolContext, type ToolResult } from "@/tools/types";
import { ensureDir } from "@/utils";
import { dirname, resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const Args = z.object({
  file_path: z.string().describe("Path to the file to write"),
  content: z.string().describe("Full file content to write"),
});

export const writeTool = makeTool({
  name: "Write",
  description: "Creates or overwrites a file with the given content. Creates parent directories as needed.",
  schema: Args,
  permission: "write",
  async execute(ctx: ToolContext, input: z.infer<typeof Args>): Promise<ToolResult> {
    const p = resolve(ctx.cwd, input.file_path);
    if (existsSync(p)) {
      try {
        const existing = readFileSync(p, "utf8");
        if (existing === input.content) {
          return { output: `No changes: ${p} is already up to date` };
        }
      } catch {}
    }
    ensureDir(dirname(p));
    writeFileSync(p, input.content, "utf8");
    return { output: `Wrote ${input.content.length} bytes to ${p}` };
  },
});

export type WriteTool = typeof writeTool;