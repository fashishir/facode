import { z } from "zod";
import { makeTool, type ToolContext, type ToolResult } from "@/tools/types";
import { truncate } from "@/utils";
import { relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const Args = z.object({
  pattern: z.string().describe("Glob pattern, e.g. '**/*.ts' or 'src/**/*.tsx'"),
  path: z.string().optional().describe("Directory to search in (default: cwd)"),
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
]);

export const globTool = makeTool({
  name: "Glob",
  description:
    "Fast file search by glob pattern. Skips node_modules, build directories, and hidden files. Returns matching file paths.",
  schema: Args,
  permission: "read",
  async execute(ctx: ToolContext, input: z.infer<typeof Args>): Promise<ToolResult> {
    const base = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
    const pattern = input.pattern;

    let files: string[] | undefined;
    // Prefer git ls-files when available (fast, respects .gitignore)
    try {
      const out = execFileSync("git", ["ls-files", "--", pattern], {
        cwd: base,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const listed = out.trim() ? out.trim().split(/\r?\n/) : [];
      if (listed.length) {
        files = listed.map((f) => {
          const abs = resolve(base, f);
          return relative(ctx.cwd, abs).replace(/\\/g, "/");
        });
      }
    } catch {
      // git missing or not a repo — fall through to the walk
    }

    if (!files) {
      const { readdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { minimatch } = await import("minimatch");
      const matches: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 10) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (IGNORE_DIRS.has(e.name)) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) {
            if (!e.name.startsWith(".")) walk(p, depth + 1);
          } else if (e.isFile()) {
            const relFromBase = relative(base, p).replace(/\\/g, "/");
            const relFromCwd = relative(ctx.cwd, p).replace(/\\/g, "/");
            if (
              minimatch(relFromBase, pattern, { dot: false }) ||
              minimatch(relFromCwd, pattern, { dot: false })
            ) {
              matches.push(relFromCwd);
            }
          }
        }
      };
      walk(base, 0);
      files = matches;
    }

    const unique = Array.from(new Set(files)).sort();
    if (!unique.length) return { output: "(no matches found)" };
    const summary = `Found ${unique.length} matching file${unique.length === 1 ? "" : "s"}:\n`;
    return { output: summary + truncate(unique.join("\n"), 8000) };
  },
});

export type GlobTool = typeof globTool;
