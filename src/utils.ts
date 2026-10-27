import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export const FACODE_DIR = ".facode";
/** Paths relative to the project's .facode directory (combine with facodeDir()). */
export const SESSIONS_DIR = "sessions";
export const CONFIG_FILE = "config.json";
export const PERMISSIONS_FILE = "permissions.json";
export const MEMORY_FILE = "FACODE.md";

export function ensureDir(p: string): void {
  try {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  } catch {}
}

export function homeDir(): string {
  return process.env.FACODE_HOME ?? homedir();
}

export function projectDir(cwd: string = process.cwd()): string {
  return resolve(cwd);
}

export function facodeDir(cwd: string = process.cwd()): string {
  return join(projectDir(cwd), FACODE_DIR);
}

export function readJSON<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export interface WriteResult {
  ok: boolean;
  /** Human-readable failure reason; only set when `ok` is false. */
  error?: string;
}

/**
 * Write pretty-printed JSON.
 *
 * Returns a result instead of throwing so callers decide whether a failed
 * save is fatal. Provider/model commands surface failures to the user:
 * reporting "saved" for a file that was never written (read-only configs,
 * permission errors, a directory at the target path) is worse than failing.
 */
export function writeJSON(p: string, data: unknown): WriteResult {
  try {
    ensureDir(dirname(p));
    writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Compact token count for status displays: 950, 19.1k, 1.0M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read a file with line numbers, like Claude Code's Read tool. */
export function numberLines(content: string, start = 1): string {
  const lines = content.split("\n");
  const width = String(start + lines.length - 1).length;
  return lines
    .map((l, i) => `${String(start + i).padStart(width)}\t${l}`)
    .join("\n");
}

export function grepInText(text: string, pattern: string, flags = "g"): RegExp {
  return new RegExp(pattern, flags);
}
