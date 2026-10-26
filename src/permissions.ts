import { readJSON, writeJSON, facodeDir, PERMISSIONS_FILE } from "@/utils";
import { resolve } from "node:path";

export type PermissionMode = "default" | "plan" | "auto";

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface PermissionsState {
  mode: PermissionMode;
  rules: PermissionRules;
  alwaysAllow: Set<string>;
}

const DEFAULT_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

export function loadPermissions(cwd: string = process.cwd()): PermissionsState {
  const file = resolve(facodeDir(cwd), PERMISSIONS_FILE);
  const data = readJSON<{ mode?: PermissionMode; rules?: Partial<PermissionRules>; alwaysAllow?: string[] }>(file, {});
  const alwaysAllow = new Set(data.alwaysAllow ?? []);
  return {
    mode: data.mode ?? "default",
    rules: { ...DEFAULT_RULES, ...data.rules },
    alwaysAllow,
  };
}

export function savePermissions(cwd: string, state: PermissionsState): void {
  const file = resolve(facodeDir(cwd), PERMISSIONS_FILE);
  writeJSON(file, {
    mode: state.mode,
    rules: state.rules,
    alwaysAllow: Array.from(state.alwaysAllow),
  });
}

/**
 * Decide whether a tool call may proceed.
 * - `auto`: always allow
 * - `plan`: allow read-only; require approval for write/exec
 * - `default`: require approval for write/exec (unless in alwaysAllow)
 */
export function decide(
  state: PermissionsState,
  tool: string,
  level: "read" | "write" | "exec" | "none"
): boolean {
  if (state.alwaysAllow.has(tool)) return true;
  if (state.mode === "auto") return true;
  if (state.mode === "plan") return level === "read";
  // default: read always ok, write/exec need approval
  return level === "read";
}

export function isInteractiveLevel(level: "read" | "write" | "exec" | "none"): boolean {
  return level !== "read";
}