import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  FacodeConfig,
  getProviderPresets,
  loadConfig,
  maskKey,
  presetApiKey,
  resolveProviderOptions,
  saveConfig,
  saveUserConfig,
  userConfigPath,
  validateProviderInput,
} from "@/config";
import { readJSON } from "@/utils";

/**
 * Provider/model management operations shared by the CLI subcommands
 * (`facode provider add|list|use|remove|test`, `facode model set|show`) and the
 * slash commands (`/provider ...`, `/model ...`).
 *
 * Each operation mutates ONE config layer — the raw file, never the merged
 * view — so saving a user-level provider never copies project values into
 * ~/.facode/config.json and vice versa.
 */

export type Scope = "user" | "project";

function rawUserConfig(): FacodeConfig {
  return readJSON<FacodeConfig>(userConfigPath(), {});
}

function rawProjectConfig(cwd: string): FacodeConfig {
  return readJSON<FacodeConfig>(join(cwd, ".facode", "config.json"), {});
}

function writeScopeLayer(scope: Scope, cwd: string, cfg: FacodeConfig): void {
  if (scope === "user") saveUserConfig(cfg);
  else saveConfig(cwd, cfg);
}

function scopeLabel(scope: Scope, cwd: string): string {
  return scope === "user"
    ? "user config (~/.facode/config.json)"
    : `project config (${join(cwd, ".facode", "config.json")})`;
}

export interface AddProviderInput {
  name: string;
  baseURL: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  scope?: Scope;
  cwd?: string;
}

export function addProvider(input: AddProviderInput): string {
  const scope = input.scope ?? "user";
  const cwd = input.cwd ?? process.cwd();
  const error = validateProviderInput(input);
  if (error) return error;

  const raw = scope === "user" ? rawUserConfig() : rawProjectConfig(cwd);
  const providers = { ...(raw.providers ?? {}) };
  if (providers[input.name]) {
    return [
      `Provider "${input.name}" already exists in ${scopeLabel(scope, cwd)}.`,
      `Remove it first: facode provider remove ${input.name}`,
    ].join("\n");
  }
  // `env:VARNAME` keys are stored as an apiKeyEnv reference — the secret
  // stays in the environment, never on disk.
  const isEnvRef = !!input.apiKey?.startsWith("env:");
  const apiKeyEnv = input.apiKeyEnv ?? (isEnvRef ? input.apiKey!.slice(4).trim() : undefined);
  providers[input.name] = {
    baseURL: input.baseURL,
    apiKey: isEnvRef ? "" : input.apiKey ?? "",
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    model: input.model ?? "",
  };
  raw.providers = providers;
  writeScopeLayer(scope, cwd, raw);

  return [
    `✔ Provider "${input.name}" added to ${scopeLabel(scope, cwd)}.`,
    `  Base URL: ${input.baseURL}`,
    `  API key:  ${apiKeyEnv ? `env:${apiKeyEnv}` : maskKey(input.apiKey)}`,
    `  Model:    ${input.model || "(none set — facode model set <model>)"}`,
    "",
    `Switch to it:  facode provider use ${input.name}`,
    `Verify it:     facode provider test ${input.name}`,
  ].join("\n");
}

export function listProviderSetups(cwd: string = process.cwd()): string {
  const cfg = loadConfig(cwd);
  const presets = getProviderPresets(cfg);
  const resolved = resolveProviderOptions(cfg);
  const current = cfg.activeProvider ?? (cfg.provider && cfg.provider !== "openai" ? cfg.provider : undefined);

  const lines = Object.entries(presets).map(([name, p]) => {
    const marker = name === current ? "•" : " ";
    const key = p.apiKeyEnv ? `env:${p.apiKeyEnv}` : maskKey(p.apiKey);
    return `  ${marker} ${name.padEnd(14)} ${p.baseURL.padEnd(40)} key: ${key}  model: ${p.model || "-"}`;
  });

  return [
    `Active: ${current ?? "(legacy/env — see /provider)"}`,
    `Resolved model: ${resolved.model || "(none — facode model set <model>)"}`,
    "",
    "Providers:",
    ...lines,
  ].join("\n");
}

export function useProvider(cwd: string, name: string, scope: Scope = "user"): string {
  const cfg = loadConfig(cwd);
  const presets = getProviderPresets(cfg);
  if (!presets[name]) {
    return `Unknown provider "${name}". Available: ${Object.keys(presets).join(", ")}`;
  }

  const raw = scope === "user" ? rawUserConfig() : rawProjectConfig(cwd);
  raw.activeProvider = name;
  writeScopeLayer(scope, cwd, raw);

  const notes: string[] = [];
  if (scope === "user") {
    const projectRaw = rawProjectConfig(cwd);
    if (projectRaw.activeProvider && projectRaw.activeProvider !== name) {
      notes.push(
        `  note: this project's config pins activeProvider="${projectRaw.activeProvider}" — it wins inside this project (facode provider use ${projectRaw.activeProvider} --scope project to change).`
      );
    }
  }

  const merged = loadConfig(cwd);
  const resolved = resolveProviderOptions(merged);
  return [
    `✔ Active provider set to "${name}" (saved to ${scopeLabel(scope, cwd)}).`,
    `  Model:    ${resolved.model || "(none — facode model set <model>)"}`,
    `  Base URL: ${resolved.baseURL ?? "(default)"}`,
    ...notes,
  ].join("\n");
}

export function removeProvider(cwd: string, name: string, scope: Scope = "user"): string {
  const raw = scope === "user" ? rawUserConfig() : rawProjectConfig(cwd);
  if (!raw.providers?.[name]) {
    const merged = loadConfig(cwd);
    if (getProviderPresets(merged)[name]) {
      return `Provider "${name}" is not registered in ${scopeLabel(scope, cwd)} — it may live in the other scope or be built-in (built-ins cannot be removed).`;
    }
    return `Unknown provider "${name}".`;
  }

  delete raw.providers[name];
  let removedActive = false;
  if (raw.activeProvider === name) {
    delete raw.activeProvider;
    removedActive = true;
  }
  writeScopeLayer(scope, cwd, raw);

  const notes: string[] = [];
  if (removedActive) {
    notes.push(`  note: "${name}" was the active ${scope}-level provider — clear now.`);
  }
  if (loadConfig(cwd).activeProvider === name) {
    notes.push(`  note: "${name}" is still resolving as active from another layer — run "facode provider use <name>" to switch.`);
  }

  return [
    `✔ Provider "${name}" removed from ${scopeLabel(scope, cwd)}.`,
    ...notes,
  ].join("\n");
}

/** Ping `${baseURL}/models` with the preset's key to verify the endpoint works. */
export async function testProvider(cwd: string, name: string): Promise<string> {
  const cfg = loadConfig(cwd);
  const preset = getProviderPresets(cfg)[name];
  if (!preset) {
    return `Unknown provider "${name}". Available: ${Object.keys(getProviderPresets(cfg)).join(", ")}`;
  }
  const apiKey = presetApiKey(preset);
  const url = preset.baseURL.replace(/\/+$/, "") + "/models";

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      return `✖ ${name}: HTTP ${res.status} from ${url}\n  ${body}`;
    }
    let count = 0;
    let sample = "";
    try {
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      count = data.data?.length ?? 0;
      sample = data.data?.[0]?.id ?? "";
    } catch {
      /* not JSON — endpoint reachable anyway */
    }
    return [
      `✔ ${name}: endpoint reachable (${url})`,
      `  key:      ${preset.apiKeyEnv ? `env:${preset.apiKeyEnv}` : maskKey(apiKey)}`,
      `  models:   ${count}${sample ? ` (e.g. ${sample})` : ""}`,
      `  model set to: ${preset.model || "(none — facode model set <model>)"}`,
    ].join("\n");
  } catch (e: any) {
    return `✖ ${name}: connection failed — ${e?.message ?? e}`;
  }
}

export function setModel(cwd: string, model: string, scope: Scope = "user"): string {
  const raw = scope === "user" ? rawUserConfig() : rawProjectConfig(cwd);
  raw.model = model;
  writeScopeLayer(scope, cwd, raw);
  const resolved = resolveProviderOptions(loadConfig(cwd));
  return [
    `✔ Model set to "${model}" (saved to ${scopeLabel(scope, cwd)}).`,
    `  Provider: ${resolved.provider ?? "openai"}`,
    `  Base URL: ${resolved.baseURL ?? "(default)"}`,
  ].join("\n");
}

export function showModel(cwd: string = process.cwd()): string {
  const cfg = loadConfig(cwd);
  const resolved = resolveProviderOptions(cfg);
  return [
    `Current model:   ${resolved.model || "(none configured)"}`,
    `Active provider: ${cfg.activeProvider ?? cfg.provider ?? "openai"}`,
    `Base URL:        ${resolved.baseURL ?? "(default)"}`,
  ].join("\n");
}

/**
 * Interactive `provider add` — asks for whatever the caller didn't provide
 * (name, base URL, API key, model). Requires a TTY; used by
 * `facode provider add` with no flags, the fresh-user onboarding path.
 */
export async function interactiveAddProvider(
  opts: {
    name?: string;
    baseURL?: string;
    apiKey?: string;
    model?: string;
    scope?: Scope;
    cwd?: string;
  } = {}
): Promise<string> {
  if (!stdin.isTTY) {
    return [
      "Interactive prompts need a terminal (TTY).",
      "Non-interactive usage:",
      "  facode provider add <name> --base-url <url> --api-key <key> [--model <m>]",
    ].join("\n");
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, fallback?: string) => {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${q}${suffix}: `)).trim();
    return answer || fallback || "";
  };
  try {
    const name = opts.name || (await ask("Provider name (e.g. myproxy)"));
    const baseURL = opts.baseURL || (await ask("Base URL (e.g. https://api.example.com/v1)"));
    const apiKey =
      opts.apiKey || (await ask("API key (or env:VARNAME to reference an environment variable)"));
    const model =
      opts.model || (await ask("Default model for this provider (optional)", ""));
    // addProvider itself normalizes `env:VARNAME` keys into apiKeyEnv refs.
    return addProvider({ name, baseURL, apiKey, model, scope: opts.scope, cwd: opts.cwd });
  } finally {
    rl.close();
  }
}
