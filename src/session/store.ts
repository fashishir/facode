import { ensureDir, facodeDir, SESSIONS_DIR, projectDir } from "@/utils";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import type { Message } from "@/agent/types";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  summary?: string;
  messageCount: number;
}

/** Load all sessions for current project. */
export function listSessions(): SessionMeta[] {
  const dir = resolve(facodeDir(), SESSIONS_DIR);
  try {
    ensureDir(dir);
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    return files
      .map((f) => {
        const p = join(dir, f);
        const s = statSync(p);
        return { id: basename(f, ".jsonl"), path: p, mtime: s.mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .map(({ id, path }) => loadMeta(id, path));
  } catch {
    return [];
  }
}

function loadMeta(id: string, path: string): SessionMeta {
  let messageCount = 0;
  let cwd = process.cwd();
  let summary: string | undefined;
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      messageCount++;
      const msg = JSON.parse(line) as Message & { _meta?: any };
      if (msg._meta?.cwd) cwd = msg._meta.cwd;
      if (msg._meta?.summary) summary = msg._meta.summary;
    }
  } catch {}
  try {
    const s = statSync(path);
    return {
      id,
      createdAt: s.birthtime.toISOString(),
      updatedAt: s.mtime.toISOString(),
      cwd,
      summary,
      messageCount,
    };
  } catch {
    const now = new Date().toISOString();
    return {
      id,
      createdAt: now,
      updatedAt: now,
      cwd,
      summary,
      messageCount,
    };
  }
}

/** Load full message history for a session. */
export function loadSession(id: string): Message[] {
  const path = resolve(facodeDir(), SESSIONS_DIR, `${id}.jsonl`);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const msgs: Message[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as Message & { _meta?: any };
        const { _meta, ...msg } = parsed;
        msgs.push(msg);
      } catch {}
    }
    return msgs;
  } catch {
    return [];
  }
}

/** Append a message to session file. */
export function appendSession(id: string, msg: Message, meta?: { cwd?: string; summary?: string }): void {
  const path = resolve(facodeDir(), SESSIONS_DIR, `${id}.jsonl`);
  try {
    ensureDir(dirname(path));
    const line = JSON.stringify({ ...msg, _meta: meta }) + "\n";
    writeFileSync(path, line, { flag: "a", encoding: "utf8" });
  } catch {
    // Tolerated if disk is read-only or in sandboxed execution
  }
}

/** Create new session. */
export function createSession(cwd: string): string {
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const msg: Message = {
    role: "system",
    content: `Session started at ${new Date().toISOString()}`,
  };
  appendSession(id, msg, { cwd });
  return id;
}

function dirname(p: string): string {
  return resolve(p, "..");
}

/** Compact a session: summarize old messages, keep recent N. */
export async function compactSession(
  id: string,
  keep: number,
  summarizer: (messages: Message[]) => Promise<string>
): Promise<void> {
  const path = resolve(facodeDir(), SESSIONS_DIR, `${id}.jsonl`);
  if (!existsSync(path)) return;
  const all = loadSession(id);
  if (all.length <= keep) return;
  const toSummarize = all.slice(0, all.length - keep);
  const recent = all.slice(all.length - keep);
  const summary = await summarizer(toSummarize);
  const newMeta: Message = {
    role: "system",
    content: `[Context compacted] ${summary}`,
    _meta: { summary },
  };
  try {
    const lines = [JSON.stringify(newMeta), ...recent.map((m) => JSON.stringify(m))].join("\n") + "\n";
    writeFileSync(path, lines, "utf8");
  } catch {}
}
