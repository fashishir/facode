import { z } from "zod";
import { makeTool, type ToolContext, type ToolResult } from "@/tools/types";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const Args = z.object({
  file_path: z.string().describe("Path to the file to edit"),
  old_string: z.string().describe("Exact string to replace (must be unique in the file)"),
  new_string: z.string().describe("Replacement string"),
  replace_all: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences (default false)"),
});

function createDiffPreview(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const preview: string[] = [];
  for (const l of oldLines.slice(0, 10)) {
    preview.push(`- ${l}`);
  }
  if (oldLines.length > 10) preview.push(`- ... (${oldLines.length - 10} more lines)`);
  for (const l of newLines.slice(0, 10)) {
    preview.push(`+ ${l}`);
  }
  if (newLines.length > 10) preview.push(`+ ... (${newLines.length - 10} more lines)`);
  return preview.join("\n");
}

export const editTool = makeTool({
  name: "Edit",
  description:
    "Performs a precise string replacement in an existing file. old_string must match exactly and be unique.",
  schema: Args,
  permission: "write",
  async execute(ctx: ToolContext, input: z.infer<typeof Args>): Promise<ToolResult> {
    const p = resolve(ctx.cwd, input.file_path);
    const relPath = relative(ctx.cwd, p).replace(/\\/g, "/");
    let content: string;
    try {
      content = readFileSync(p, "utf8");
    } catch (e: any) {
      return { output: `Error reading ${relPath}: ${e?.message ?? e}`, error: true };
    }

    if (!content.includes(input.old_string)) {
      return {
        output: `Error: old_string not found in ${relPath}. Ensure exact indentation and characters match.`,
        error: true,
      };
    }

    const count = content.split(input.old_string).length - 1;
    if (count > 1 && !input.replace_all) {
      return {
        output: `Error: old_string appears ${count} times in ${relPath}. Make it unique by including surrounding lines, or pass replace_all: true.`,
        error: true,
      };
    }

    const newContent = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string);

    writeFileSync(p, newContent, "utf8");
    const diff = createDiffPreview(input.old_string, input.new_string);
    return {
      output: `Successfully edited ${relPath} (${input.replace_all ? count : 1} replacement):\n\n\`\`\`diff\n${diff}\n\`\`\``,
    };
  },
});

export type EditTool = typeof editTool;
