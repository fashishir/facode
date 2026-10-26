import { readJSON, writeJSON } from "@/utils";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export type PermissionMode = "default" | "plan" | "auto";

/** A named LLM provider preset: an OpenAI-compatible endpoint + credentials. */
export interface ProviderPreset {
  baseURL: string;
  /** Plaintext API key. Prefer `apiKeyEnv` to keep secrets out of config files. */
  apiKey: string;
  /** Name of an environment variable holding the API key (resolved at use time). */
  apiKeyEnv?: string;
  model: string;
  maxTokens?: number;
}

export interface FacodeConfig {
  model?: string;
  baseURL?: string;
  apiKey?: string;
  provider?: "openai" | "anthropic" | "ollama" | "custom";
  /** Active provider name (key into `providers`). Falls back to `provider`/`openai`. */
  activeProvider?: string;
  /** Named provider presets keyed by name. Each is an OpenAI-compatible endpoint. */
  providers?: Record<string, ProviderPreset>;
  permissionMode?: PermissionMode;
  maxTokens?: number;
  contextWindow?: number;
  compactionThreshold?: number;
  systemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
  subagents?: Record<string, SubagentConfig>;
  skillsDir?: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface SubagentConfig {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

const DEFAULTS: FacodeConfig = {
  provider: "openai",
  permissionMode: "default",
  maxTokens: 8192,
  contextWindow: 128_000,
  compactionThreshold: 0.8,
};

/**
 * Built-in provider presets. Each is an OpenAI-compatible endpoint, so any
 * provider that speaks the OpenAI chat completions API works out of the box.
 * Override via `.facode/config.json` `providers` or `FACODE_*` env vars.
 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    // Honor OPENAI_BASE_URL when set so zero-config setups using an
    // OpenAI-compatible proxy (Token Harbor, Azure gateway, etc.) work from
    // any directory — the fallback preset must not hard-code api.openai.com,
    // or the proxy key gets sent to real OpenAI and 401s.
    baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: "gpt-4o",
  },
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    model: "deepseek-chat",
  },
  pi: {
    baseURL: "https://api.pi.ai/v1",
    apiKey: process.env.PI_API_KEY ?? "",
    model: "pi",
  },
  anthropic: {
    baseURL: "https://api.anthropic.com/v1",
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: "claude-3-5-sonnet-latest",
  },
  ollama: {
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
    model: "llama3.1",
  },
};

/**
 * User-level config dir: `%USERPROFILE%\.facode` (override with
 * FACODE_USER_DIR, used by tests for isolation). Facode merges config layers:
 * defaults < user (~/.facode/config.json) < project (.facode/config.json) < env.
 * The user layer is what makes `facode` work from any directory — not just
 * projects that carry their own .facode/config.json.
 */
export const PROVIDER_NAME_RE = /^[a-z][\w-]*$/i;

/** Mask an API key for display: first 8 + "..." + last 4. */
export function maskKey(key?: string): string {
  if (!key) return "(unset)";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

/** Merged provider registry: built-in presets + configured `cfg.providers`. */
export function getProviderPresets(cfg: FacodeConfig): Record<string, ProviderPreset> {
  return { ...PROVIDER_PRESETS, ...(cfg.providers ?? {}) };
}

/** Resolve the effective API key of a preset (apiKeyEnv lookup wins over apiKey). */
export function presetApiKey(preset: ProviderPreset): string {
  if (preset.apiKeyEnv) {
    return process.env[preset.apiKeyEnv] ?? "";
  }
  return preset.apiKey;
}

/**
 * Validate `provider add` input. Returns an error message, or null when valid.
 * `requireKey` is false for updates, where credentials may be left unchanged.
 */
export function validateProviderInput(
  input: { name: string; baseURL: string; apiKey?: string; apiKeyEnv?: string; model?: string },
  requireKey = true
): string | null {
  if (!PROVIDER_NAME_RE.test(input.name)) {
    return `Invalid provider name "${input.name}" — use letters/digits/-/_ starting with a letter.`;
  }
  if (!input.baseURL) {
    return "Missing base URL — e.g. https://api.example.com/v1";
  }
  try {
    const u = new URL(input.baseURL);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return `Base URL must be http(s), got "${u.protocol}"`;
    }
  } catch {
    return `Invalid base URL "${input.baseURL}" — e.g. https://api.example.com/v1`;
  }
  if (requireKey && !input.apiKey && !input.apiKeyEnv) {
    return "Missing API key — pass --api-key <key> (or --api-key-env NAME to reference an env var).";
  }
  return null;
}

export function userConfigPath(): string {
  const dir = process.env.FACODE_USER_DIR ?? join(homedir(), ".facode");
  return join(dir, "config.json");
}

export function loadConfig(cwd: string = process.cwd()): FacodeConfig {
  const userConfig = readJSON<FacodeConfig>(userConfigPath(), {});
  const file = join(cwd, ".facode", "config.json");
  const fileConfig = readJSON<FacodeConfig>(file, {});
  const env: FacodeConfig = {};
  if (process.env.FACODE_MODEL) env.model = process.env.FACODE_MODEL;
  if (process.env.FACODE_BASE_URL) env.baseURL = process.env.FACODE_BASE_URL;
  if (process.env.FACODE_API_KEY) env.apiKey = process.env.FACODE_API_KEY;
  if (process.env.FACODE_PROVIDER) env.provider = process.env.FACODE_PROVIDER as FacodeConfig["provider"];
  if (process.env.FACODE_PERMISSION_MODE)
    env.permissionMode = process.env.FACODE_PERMISSION_MODE as PermissionMode;
  const merged: FacodeConfig = { ...DEFAULTS, ...userConfig, ...fileConfig, ...env };
  // Record-valued fields merge key-by-key across layers: a project that
  // defines its own `providers` (or mcpServers/subagents) must NOT hide the
  // user-level entries — later layers override per key, not wholesale.
  if (userConfig.providers || fileConfig.providers) {
    merged.providers = { ...userConfig.providers, ...fileConfig.providers };
  }
  if (userConfig.mcpServers || fileConfig.mcpServers) {
    merged.mcpServers = { ...userConfig.mcpServers, ...fileConfig.mcpServers };
  }
  if (userConfig.subagents || fileConfig.subagents) {
    merged.subagents = { ...userConfig.subagents, ...fileConfig.subagents };
  }
  return merged;
}

/**
 * Resolve the effective provider options (base URL + API key + model) for a
 * config. Resolution order:
 *   1. Explicitly chosen named preset (`activeProvider`/`provider` in
 *      `cfg.providers` or the built-in `PROVIDER_PRESETS`).
 *   2. Legacy top-level `cfg.baseURL` / `cfg.apiKey` / `cfg.model` — this is
 *      the pre-0.2 behavior and remains the default when no preset is selected.
 *   3. Built-in `openai` preset (only when nothing is configured at all).
 */
export function resolveProviderOptions(cfg: FacodeConfig): {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
} {
  // `activeProvider` is the only unambiguous explicit selector, but it only
  // counts when it's not the default "openai" — otherwise the DEFAULTS value
  // would silently hijack every legacy custom-endpoint setup. The same rule
  // applies to `provider`.
  const name =
    cfg.activeProvider && cfg.activeProvider !== "openai"
      ? cfg.activeProvider
      : cfg.provider && cfg.provider !== "openai"
        ? cfg.provider
        : undefined;
  const presets = getProviderPresets(cfg);
  const preset = name ? presets[name] : undefined;

  // 1. Explicitly chosen named preset
  if (preset) {
    return {
      provider: name,
      baseURL: preset.baseURL,
      apiKey: presetApiKey(preset),
      // Empty strings fall through so a preset without a model (or without a
      // global override) doesn't lock in "".
      model: cfg.model || preset.model || "",
      maxTokens: preset.maxTokens ?? cfg.maxTokens,
    };
  }

  // 2. Legacy custom endpoint — preserves the pre-0.2 behavior where
  //    OPENAI_BASE_URL/OPENAI_API_KEY/FACODE_* were used directly. This is the
  //    default when no preset is selected, so existing setups don't break.
  if (cfg.baseURL || cfg.apiKey || cfg.model) {
    return {
      provider: name ?? "custom",
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      model: cfg.model ?? "gpt-4o",
      maxTokens: cfg.maxTokens,
    };
  }

  // 3. Nothing configured — fall back to the built-in openai preset.
  const fallback = presets.openai;
  return {
    provider: "openai",
    baseURL: fallback.baseURL,
    apiKey: fallback.apiKey,
    model: fallback.model,
  };
}

/** List the names of all available provider presets (built-in + configured). */
export function listProviders(cwd: string = process.cwd()): string[] {
  const cfg = loadConfig(cwd);
  return Object.keys({ ...PROVIDER_PRESETS, ...(cfg.providers ?? {}) });
}

/** The built-in provider preset names (openai, deepseek, pi, anthropic, ollama). */
export const providerPresetNames = (): string[] => Object.keys(PROVIDER_PRESETS);

export function defaultSystemPrompt(cwd: string): string {
  const instructions: string[] = [];
  const memoryCandidates = [
    join(cwd, "FACODE.md"),
    join(cwd, "CLAUDE.md"),
    join(cwd, ".facode", "FACODE.md"),
  ];
  for (const candidate of memoryCandidates) {
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, "utf8").trim();
        if (content) {
          instructions.push(`\n## Project Memory & Context (${basename(candidate)}):\n${content}`);
          break;
        }
      } catch {}
    }
  }

  return [
    "You are FA Code, an autonomous CLI coding agent and reverse engineering expert built with the UX and capabilities of Claude Code.",
    `Working directory: ${cwd}`,
    `Platform: ${process.platform} (${process.arch})`,
    "",
    "## Claude Code Interaction Principles",
    "- Be direct, concise, and focused on solutions. You are collaborating with a software engineer.",
    "- Always verify before and after modifications: use Read, Glob, Grep to understand code context before editing.",
    "- Make minimal, surgical edits using the Edit tool. Avoid rewriting entire files when touching localized logic.",
    "- Format responses in clean GitHub-flavored markdown with syntax highlighted code blocks.",
    "- Ask for confirmation before running destructive, irreversible, or network-altering actions.",
    "",
    "## Tools Reference",
    "- Bash: Run shell commands, tests, builds, or git operations.",
    "- Read: Read file contents with 1-based line numbering, supporting offset and limit.",
    "- Write: Create or overwrite files, automatically ensuring parent directories.",
    "- Edit: Perform exact find-and-replace edits on files.",
    "- Glob: Fast file and directory pattern search.",
    "- Grep: Regex content search across files, skipping node_modules and binary assets.",
    "- Task: Delegate complex, multi-step subtasks to specialized subagents ('reverse-engineer', 'explore').",
    "- REA (Reverse Engineering Anything) Tools:",
    "  * rea_triage: Classify an artifact and recommend the exact REA workflow based on the REA skill matrix.",
    "  * rea_analyze: Reconstruct and summarize local applications, binaries, or JS bundles.",
    "  * rea_decompile: Decompile functions, classes, or bundles to readable source.",
    "  * rea_doctor: Verify engine health (Hopper, Ghidra, IDA, JADX) and REA environment.",
    "  * rea_search_tools: Search over 200+ specialized REA tools by keyword.",
    "  * rea_call_tool: Execute any specific REA tool dynamically.",
    "",
    "## Reverse Engineering Workflow (REA Skill Guidelines)",
    "When investigating binaries, packages, or unknown applications, route the target first:",
    "- Electron / ASAR: use `analyze_javascript_application` or `rea_analyze`.",
    "- Android APK / AAB: use `inspect_android_package`, `inspect_android_class`, `inspect_android_method`.",
    "- Windows PE / .NET: use `inspect_managed_artifact` (for .NET) or `open_binary` + `inspect_binary_layout`.",
    "- Native binary / Mach-O / ELF: use `open_binary`, `binary_overview`, `list_procedures`, `search_strings`.",
    "- Web bundles: use `analyze_web_bundle`, `trace_web_module_imports`, `recover_javascript_sources`.",
    "- Always back up every finding with concrete evidence (offsets, hex addresses, symbol names, disassembled lines).",
    ...instructions,
  ].join("\n");
}

export const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {
  rea: {
    command: "npx",
    args: ["-y", "rea-agents@6.7.0", "mcp"],
    env: {},
  },
};

export function defaultSubagents(): Record<string, SubagentConfig> {
  return {
    "reverse-engineer": {
      description:
        "Reverse engineer binaries, apps, firmware, APKs, and web bundles using REA skill guidelines and evidence ledger.",
      prompt: [
        "You are a specialized reverse-engineering subagent for FA Code built around the REA (Reverse Engineering Anything) skill.",
        "Your mission is to perform evidence-based reverse engineering, decompilation, and structural analysis of targets.",
        "",
        "## Methodology (REA Skill)",
        "1. Route target first based on artifact format (ASAR -> analyze_javascript_application, APK -> inspect_android_package, PE/.NET -> inspect_managed_artifact, native -> open_binary/binary_overview).",
        "2. Formulate explicit hypotheses before querying engines.",
        "3. Collect concrete Evidence records: hex addresses, symbol names, decompiled source, or string references.",
        "4. Structure your response into: Target Identification, Methodology, Concrete Evidence & Findings, and Remaining Unknowns/Limitations.",
        "5. Never guess or hallucinate disassembly or addresses.",
      ].join("\n"),
      tools: ["mcp__rea__*", "rea_*", "Read", "Bash", "Grep"],
    },
    "explore": {
      description: "Fast read-only codebase exploration. Use to search files, symbols, and architecture before making changes.",
      prompt:
        "You are a fast, read-only exploration subagent for FA Code. Use Glob, Grep, and Read to thoroughly answer questions about codebase architecture and dependencies.",
      tools: ["Glob", "Grep", "Read"],
    },
  };
}

export const HOME = homedir();

export function saveConfig(cwd: string, cfg: FacodeConfig): void {
  writeJSON(join(cwd, ".facode", "config.json"), cfg);
}

/** Save to the user-level config (~/.facode/config.json) — applies everywhere. */
export function saveUserConfig(cfg: FacodeConfig): void {
  writeJSON(userConfigPath(), cfg);
}
