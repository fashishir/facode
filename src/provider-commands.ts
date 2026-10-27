import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  FacodeConfig,
  getProviderPresets,
  isFreeModel,
  loadConfig,
  maskKey,
  presetApiKey,
  PROVIDER_PRESETS,
  ProviderPreset,
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
  /** Overwrite the provider if it already exists in the target scope. */
  force?: boolean;
}

export function addProvider(input: AddProviderInput): string {
  const scope = input.scope ?? "user";
  const cwd = input.cwd ?? process.cwd();
  const error = validateProviderInput(input);
  if (error) return error;

  const raw = scope === "user" ? rawUserConfig() : rawProjectConfig(cwd);
  const providers = { ...(raw.providers ?? {}) };
  const overwrote = !!providers[input.name];
  if (overwrote && !input.force) {
    return [
      `Provider "${input.name}" already exists in ${scopeLabel(scope, cwd)}.`,
      `Remove it first: facode provider remove ${input.name}`,
      `Or change it:    facode provider set ${input.name} --base-url <url> --api-key <key>`,
      `Or overwrite:    facode provider add ${input.name} ... --force`,
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
    `✔ Provider "${input.name}" ${overwrote ? "overwritten in" : "added to"} ${scopeLabel(scope, cwd)}.`,
    `  Base URL: ${input.baseURL}`,
    `  API key:  ${apiKeyEnv ? `env:${apiKeyEnv}` : maskKey(input.apiKey)}`,
    `  Model:    ${input.model || "(none set — facode model set <model>)"}`,
    "",
    `Switch to it:  facode provider use ${input.name}`,
    `Verify it:     facode provider test ${input.name}`,
  ].join("\n");
}

export interface UpdateProviderInput {
  name: string;
  /** Omitted fields keep their current value (partial update). */
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  scope?: Scope;
  cwd?: string;
}

/**
 * Update an existing CUSTOM provider in place (partial update — only what's
 * passed changes; the stored key survives unless a new one is given). Built-in
 * preset names are refused, consistent with `removeProvider` protecting them.
 */
export function updateProvider(input: UpdateProviderInput): string {
  const scope = input.scope ?? "user";
  const cwd = input.cwd ?? process.cwd();
  const raw = scope === "user" ? rawUserConfig() : rawProjectConfig(cwd);
  const existing = raw.providers?.[input.name];
  if (!existing) {
    if (PROVIDER_PRESETS[input.name]) {
      return [
        `Provider "${input.name}" is built-in and cannot be modified.`,
        `Register your endpoint under a new name instead: facode provider add <name> --base-url <url> --api-key <key>`,
      ].join("\n");
    }
    return [
      `Unknown provider "${input.name}" in ${scopeLabel(scope, cwd)}.`,
      `Registered here: ${Object.keys(raw.providers ?? {}).join(", ") || "(none)"}`,
      `To create it: facode provider add ${input.name} --base-url <url> --api-key <key>`,
    ].join("\n");
  }

  const baseURL = input.baseURL ?? existing.baseURL;
  const error = validateProviderInput({ name: input.name, baseURL }, false);
  if (error) return error;

  const next: ProviderPreset = {
    ...existing,
    baseURL,
    model: input.model ?? existing.model,
  };
  // Key handling: an explicit `apiKeyEnv` (or `env:VAR` apiKey) stores a
  // reference and clears the plaintext; a plain apiKey clears any previous
  // reference (presetApiKey prefers apiKeyEnv, so leaving both would make the
  // new key a dead value). Neither given → credentials untouched.
  if (input.apiKeyEnv !== undefined || input.apiKey !== undefined) {
    const isEnvRef = !!input.apiKey?.startsWith("env:");
    const env = input.apiKeyEnv ?? (isEnvRef ? input.apiKey!.slice(4).trim() : undefined);
    if (env) {
      next.apiKeyEnv = env;
      next.apiKey = "";
    } else {
      next.apiKey = input.apiKey ?? "";
      delete next.apiKeyEnv;
    }
  }

  raw.providers![input.name] = next;
  writeScopeLayer(scope, cwd, raw);

  return [
    `✔ Provider "${input.name}" updated in ${scopeLabel(scope, cwd)}.`,
    `  Base URL: ${next.baseURL}`,
    `  API key:  ${next.apiKeyEnv ? `env:${next.apiKeyEnv}` : maskKey(next.apiKey)}`,
    `  Model:    ${next.model || "(none set — facode model set <model>)"}`,
  ].join("\n");
}

/**
 * Show the effective failover policy (merged across config layers).
 * Pure read — no config is touched.
 */
export function showFailover(cwd: string = process.cwd()): string {
  const cfg = loadConfig(cwd);
  const f = cfg.failover;
  if (!f || f.enabled === false) {
    return [
      "Auto-failover is OFF — when a model hits its quota, the error is surfaced to you.",
      "",
      "Turn it on:  facode failover on [--free-only] [--max-attempts 3]",
      "Turn it off: facode failover off",
    ].join("\n");
  }
  return [
    `Auto-failover is ON`,
    `  free-only:     ${f.freeOnly ? "yes (never spends paid quota)" : "no"}`,
    `  max attempts:  ${f.maxAttempts ?? 3} models tried per turn`,
    "",
    "When the active model is rate-limited, FA Code silently switches to another",
    "model on the same endpoint and retries. The switch is in-memory for the turn",
    "only — your configured model is untouched, so a fresh session starts clean.",
    "",
    "Tune it:  facode failover on [--free-only] [--max-attempts 3]",
    "Turn off: facode failover off",
  ].join("\n");
}

/**
 * Apply a failover policy change to one config layer. Pure function over the
 * raw layer — never the merged view — so a project-level change never leaks
 * user values (or API keys) into ~/.facode/config.json.
 */
export function setFailover(
  input: { enabled?: boolean; freeOnly?: boolean; maxAttempts?: number },
  scope: Scope = "user",
  cwd: string = process.cwd()
): string {
  const raw = scope === "user" ? rawUserConfig() : rawProjectConfig(cwd);
  const next: FacodeConfig["failover"] = {
    enabled: input.enabled ?? true,
    freeOnly: input.freeOnly ?? false,
    maxAttempts: input.maxAttempts ?? 3,
  };
  raw.failover = next;
  writeScopeLayer(scope, cwd, raw);
  return [
    `✔ Failover policy updated in ${scopeLabel(scope, cwd)}.`,
    `  enabled:      ${next.enabled}`,
    `  free-only:    ${next.freeOnly}`,
    `  max attempts: ${next.maxAttempts}`,
  ].join("\n");
}

export function listProviderSetups(cwd: string = process.cwd()): string {
  const cfg = loadConfig(cwd);
  const presets = getProviderPresets(cfg);
  const resolved = resolveProviderOptions(cfg);
  const current = activeProviderName(cfg);

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

/** Result of fetching an endpoint's `/models` list. */
interface ModelListResult {
  ok: boolean;
  /** Formatted error for display when !ok. */
  error?: string;
  /** All model ids, in endpoint order. */
  models: string[];
  /** Ids with a free-tier suffix (`:free` or `-free`). */
  free: string[];
}

/**
 * Fetch `${baseURL}/models` with the given key — a plain GET that does not
 * consume LLM/chat quota. Shared by `provider test`, `provider models`, and
 * `model set --pick`.
 */
async function fetchEndpointModels(baseURL: string, apiKey?: string): Promise<ModelListResult> {
  const url = baseURL.replace(/\/+$/, "") + "/models";
  try {
    const res = await fetch(url, {
      // No key → no auth header at all; sending "Bearer undefined" is worse.
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      return { ok: false, error: `HTTP ${res.status} from ${url}\n  ${body}`, models: [], free: [] };
    }
    let data: { data?: Array<{ id?: string }> };
    try {
      data = (await res.json()) as { data?: Array<{ id?: string }> };
    } catch {
      return { ok: false, error: `endpoint returned non-JSON at ${url}`, models: [], free: [] };
    }
    const models = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    const free = models.filter((id) => id.toLowerCase().endsWith(":free"));
    return { ok: true, models, free };
  } catch (e: any) {
    return { ok: false, error: `connection failed — ${e?.message ?? e}`, models: [], free: [] };
  }
}

/** The explicitly selected provider name, or undefined for the legacy/zero-config path. */
function activeProviderName(cfg: FacodeConfig): string | undefined {
  return (
    cfg.activeProvider ??
    (cfg.provider && cfg.provider !== "openai" ? cfg.provider : undefined)
  );
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
  const result = await fetchEndpointModels(preset.baseURL, apiKey);
  if (!result.ok) {
    return `✖ ${name}: ${result.error}`;
  }
  return [
    `✔ ${name}: endpoint reachable (${url})`,
    `  key:      ${preset.apiKeyEnv ? `env:${preset.apiKeyEnv}` : maskKey(apiKey)}`,
    `  models:   ${result.models.length}${result.models[0] ? ` (e.g. ${result.models[0]})` : ""}`,
    `  model set to: ${preset.model || "(none — facode model set <model>)"}`,
  ].join("\n");
}

/** List every model a provider's endpoint offers — `:free` models first. */
export async function listProviderModels(cwd: string, name: string): Promise<string> {
  const cfg = loadConfig(cwd);
  const preset = getProviderPresets(cfg)[name];
  if (!preset) {
    return `Unknown provider "${name}". Available: ${Object.keys(getProviderPresets(cfg)).join(", ")}`;
  }
  const apiKey = presetApiKey(preset);
  const url = preset.baseURL.replace(/\/+$/, "") + "/models";
  const result = await fetchEndpointModels(preset.baseURL, apiKey);
  if (!result.ok) {
    return `✖ ${name}: ${result.error}`;
  }
  if (!result.models.length) {
    return `✖ ${name}: endpoint returned no models (${url}) — check the key/URL or the provider's dashboard.`;
  }

  const free = result.models.filter(isFreeModel);
  const rest = result.models.filter((id) => !isFreeModel(id));
  const OTHER_CAP = 40;
  const otherLines = rest.slice(0, OTHER_CAP).map((id) => `    ${id}`);
  if (rest.length > OTHER_CAP) {
    otherLines.push(`    … +${rest.length - OTHER_CAP} more (not shown)`);
  }

  const freeBlock = free.length
    ? ["  Free models:", ...free.map((id) => `    ${id}`)]
    : ["  Free models: none with a ':free' or '-free' suffix"];
  const restBlock = rest.length ? ["  Other models:", ...otherLines] : [];

  return [
    `Models for "${name}" (${url}): ${result.models.length} total, ${free.length} free`,
    "",
    ...freeBlock,
    ...restBlock,
    "",
    `Set one:  facode model set <model>            (persists; in the TUI: /model <model>)`,
    `Pick one: facode model set --pick ${name}     (interactive chooser, terminal only)`,
  ].join("\n");
}

/**
 * Pure helper for the interactive picker: turn an answer (1-based number or
 * exact model id from the shown list) into a model id, or undefined when the
 * answer doesn't resolve (cancel/empty/out-of-range/unknown).
 */
export function resolvePickAnswer(answer: string, ordered: string[]): string | undefined {
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  const asNumber = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= ordered.length) {
    return ordered[asNumber - 1];
  }
  return ordered.includes(trimmed) ? trimmed : undefined;
}

/**
 * Interactive numbered model chooser (TTY only) — free models first. Persists
 * the chosen model with `setModel`. Only reachable from the CLI subcommand:
 * inside the TUI, stdin belongs to Ink, so `/model pick` renders a plain list
 * instead of prompting.
 */
export async function pickModel(
  cwd: string,
  name: string | undefined,
  scope: Scope = "user"
): Promise<string> {
  const cfg = loadConfig(cwd);
  const resolved = resolveProviderOptions(cfg);

  let baseURL: string;
  let apiKey: string | undefined;
  let label: string;
  if (name) {
    const preset = getProviderPresets(cfg)[name];
    if (!preset) {
      return `Unknown provider "${name}". Available: ${Object.keys(getProviderPresets(cfg)).join(", ")}`;
    }
    baseURL = preset.baseURL;
    apiKey = presetApiKey(preset);
    label = name;
  } else {
    // No explicit provider → use whatever the resolver would actually use
    // (built-in openai preset honoring OPENAI_BASE_URL, a named active
    // provider, or a legacy top-level custom endpoint).
    baseURL = resolved.baseURL ?? process.env.OPENAI_BASE_URL ?? "";
    apiKey = resolved.apiKey ?? process.env.OPENAI_API_KEY;
    label = resolved.provider ?? "openai";
    if (!baseURL) {
      return "No provider is configured — set one up with `facode provider add`.";
    }
  }
  if (!stdin.isTTY) {
    return [
      "The interactive picker needs a terminal (TTY).",
      `List models non-interactively:  facode provider models ${name ?? label}`,
      "Set one directly:               facode model set <model-name>",
    ].join("\n");
  }

  const result = await fetchEndpointModels(baseURL, apiKey);
  if (!result.ok) {
    return `✖ ${label}: ${result.error}`;
  }
  if (!result.models.length) {
    return `✖ ${label}: endpoint returned no models — check the key/URL.`;
  }

  const ordered = [...result.free, ...result.models.filter((id) => !result.free.includes(id))];
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(
      [
        `Models for "${label}" — free first, ${ordered.length} total:`,
        ...ordered.map((id, i) => `  ${i + 1}. ${id}${i < result.free.length ? "   (free)" : ""}`),
        "",
      ].join("\n") + "\n"
    );
    const answer = (
      await rl.question(
        `Select the model for "${label}" (number or exact name, Enter to cancel): `
      )
    ).trim();
    if (!answer) return "Pick canceled — model unchanged.";

    const model = resolvePickAnswer(answer, ordered);
    if (!model) {
      return [
        `✖ "${answer}" is not in the list — pick a number 1..${ordered.length} or an exact id above.`,
        `Browse again: facode provider models ${label}`,
      ].join("\n");
    }
    return setModel(cwd, model, scope);
  } finally {
    rl.close();
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
