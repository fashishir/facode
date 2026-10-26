import { z } from "zod";
import { makeTool, type ToolContext, type ToolResult } from "@/tools/types";
import { truncate } from "@/utils";
import { resolve, relative, extname } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";

const Args = z.object({
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().optional().describe("File or directory to search (default: cwd)"),
  include: z.string().optional().describe("Glob filter, e.g. '*.ts'"),
  glob: z.string().optional().describe("Alias for include"),
});

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".vscode",
  ".facode",
  ".next",
  "build",
  "coverage",
  ".turbo",
]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".bin",
  ".pyc",
]);

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 10) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith(".")) walk(p, depth + 1, out);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (!BINARY_EXTS.has(ext)) {
        out.push(p);
      }
    }
  }
}

export const grepTool = makeTool({
  name: "Grep",
  description:
    "Fast content search by regex across codebase files. Skips node_modules and binary files. Returns matching lines with relative file paths and line numbers.",
  schema: Args,
  permission: "read",
  async execute(ctx: ToolContext, input: z.infer<typeof Args>): Promise<ToolResult> {
    const base = resolve(ctx.cwd, input.path ?? ".");
    const filter = input.include ?? input.glob;
    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch (e: any) {
      return { output: `Invalid regex: ${e?.message ?? e}`, error: true };
    }

    const files: string[] = [];
    if (statSync(base).isFile()) {
      files.push(base);
    } else {
      walk(base, 0, files);
    }

    const matches: string[] = [];
    let matchCount = 0;
    const matchedFiles = new Set<string>();

    for (const f of files) {
      if (filter) {
        const { minimatch } = await import("minimatch");
        const rel = relative(ctx.cwd, f).replace(/\\/g, "/");
        if (!minimatch(rel, filter, { dot: true })) continue;
      }
      let content: string;
      try {
        content = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      const relPath = relative(ctx.cwd, f).replace(/\\/g, "/");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${relPath}:${i + 1}: ${lines[i].trimEnd()}`);
          matchedFiles.add(relPath);
          matchCount++;
          if (matchCount >= 200) break;
        }
      }
      if (matchCount >= 200) break;
    }

    if (!matches.length) return { output: "(no matches found)" };
    const summary = `Found ${matchCount} match${matchCount === 1 ? "" : "es"} in ${matchedFiles.size} file${matchedFiles.size === 1 ? "" : "s"}:\n\n`;
    return { output: summary + truncate(matches.join("\n"), 10000) };
  },
});

export type GrepTool = typeof grepTool;
