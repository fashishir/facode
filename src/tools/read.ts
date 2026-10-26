import { z } from "zod";
import { makeTool, type ToolContext, type ToolResult } from "@/tools/types";
import { numberLines, truncate } from "@/utils";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const Args = z.object({
  file_path: z.string().describe("Absolute or relative path to the file to read"),
  offset: z.number().optional().describe("Line number to start reading from (1-based)"),
  limit: z.number().optional().describe("Max lines to read"),
});

export const readTool = makeTool({
  name: "Read",
  description: "Reads a file from the local filesystem with line numbers. Returns the full file unless offset/limit given.",
  schema: Args,
  permission: "read",
  async execute(ctx: ToolContext, input: z.infer<typeof Args>): Promise<ToolResult> {
    const p = resolve(ctx.cwd, input.file_path);
    let content: string;
    try {
      content = readFileSync(p, "utf8");
    } catch (e: any) {
      return { output: `Error reading ${p}: ${e?.message ?? e}`, error: true };
    }
    const start = input.offset ?? 1;
    const lines = content.split("\n");
    const slice = lines.slice(start - 1, input.limit ? start - 1 + input.limit : undefined);
    const numbered = numberLines(slice.join("\n"), start);
    return { output: truncate(numbered, 12000) };
  },
});

export type ReadTool = typeof readTool;