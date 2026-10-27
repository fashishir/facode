import type OpenAI from "openai";
import type { Role, Message, ToolCall, StreamCallbacks } from "@/agent/types";
import { toInputSchema } from "@/tools/types";
import { recordUsage, type TokenUsage } from "@/agent/usage";
import {
  isFreeModel,
  loadConfig,
  maskKey,
  resolveProviderOptions,
  selectFailoverCandidates,
  type FacodeConfig,
} from "@/config";

// The `openai` SDK (~265ms import cost) is loaded lazily on the first client
// creation so CLI startup (parsers, TUI render) is not blocked by it.
let OpenAICtor: any;
async function createClient(baseURL?: string, apiKey?: string): Promise<OpenAI> {
  OpenAICtor ??= (await import("openai")).default;
  return new OpenAICtor({
    baseURL,
    apiKey,
    dangerouslyAllowBrowser: true, // needed for some proxies
  }) as OpenAI;
}

export interface ProviderOptions {
  model: string;
  baseURL?: string;
  apiKey?: string;
  maxTokens?: number;
  /**
   * Auto-failover: ordered candidate models to try when the active model is
   * rate-limited. `onSwitch` is called (with the old→new model) whenever a
   * switch happens, so the host can surface it in the UI.
   */
  failover?: {
    candidates: string[];
    onSwitch?: (from: string, to: string) => void;
    /** FacodeConfig — the failover policy (enabled/freeOnly/maxAttempts). */
    cfg: FacodeConfig;
  };
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  /** Model id that actually served this completion (may differ from options.model after auto-failover). */
  model: string;
}

/**
 * OpenAI-compatible streaming provider.
 * Uses the `openai` SDK which works with any OpenAI-compatible endpoint.
 */
export async function createCompletion(
  messages: Message[],
  options: ProviderOptions,
  tools: ReturnType<typeof toInputSchema>[] = [],
  callbacks: StreamCallbacks = {}
): Promise<CompletionResult> {
  const client = await createClient(
    options.baseURL,
    options.apiKey
  );

  // Auto-failover: when the active model hits a quota/rate-limit error, FA Code
  // silently switches to another model from the same endpoint and retries, so a
  // free-tier cap never kills a session. Candidates are discovered lazily on the
  // first quota error (one `/models` fetch, no chat quota) and consumed one at a
  // time. The switch is in-memory for the turn only — the configured model is
  // untouched, so a fresh session starts clean.
  let activeModel = options.model;
  let candidates: string[] | null = null;

  for (;;) {
    try {
      const result = await streamCompletion(client, messages, { ...options, model: activeModel }, tools, callbacks);
      // Usage accounting: every request is counted per served model. FA Code
      // never blocks requests because of the per-model 1M token budget — it
      // exists only as a tracking reference the user can inspect (/usage).
      recordUsage(result.model, result.usage ?? undefined, estimateUsage(messages, result));
      return result;
    } catch (e: any) {
      if (!isQuotaError(e)) throw e;
      if (candidates === null) {
        candidates = await getFailoverCandidates(
          options.baseURL ?? "",
          options.apiKey,
          activeModel,
          options.failover?.cfg ?? loadConfig()
        );
      }
      const next = candidates.shift();
      if (!next) throw e; // no fallback available — surface the original error
      options.failover?.onSwitch?.(activeModel, next);
      activeModel = next;
    }
  }
}

async function streamCompletion(
  client: OpenAI,
  messages: Message[],
  options: ProviderOptions,
  tools: ReturnType<typeof toInputSchema>[],
  callbacks: StreamCallbacks
): Promise<CompletionResult> {
  const stream: AsyncIterable<any> = await createStream(client, messages, options, tools);

  let content = "";
  const toolCalls: Map<number, ToolCall> = new Map();
  let reasoningContent = "";
  let usage: TokenUsage | undefined;

  for await (const chunk of stream) {
    // Servers honoring stream_options.include_usage report usage on a final
    // chunk with empty choices — capture it before the choice guard below.
    const chunkUsage = (chunk as any).usage;
    if (chunkUsage) {
      usage = {
        inputTokens: chunkUsage.prompt_tokens ?? 0,
        outputTokens: chunkUsage.completion_tokens ?? chunkUsage.output_tokens ?? 0,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    if (choice.delta.content) {
      const delta = choice.delta.content;
      content += delta;
      callbacks.onDelta?.(delta);
    }

    if ((choice.delta as any).reasoning_content) {
      const delta = (choice.delta as any).reasoning_content;
      reasoningContent += delta;
      callbacks.onReasoningDelta?.(delta);
    }

    if (choice.delta.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        let existing = toolCalls.get(idx);
        if (!existing) {
          existing = {
            id: tc.id ?? `call_${Date.now()}_${idx}`,
            type: "function",
            function: { name: "", arguments: "" },
          };
          toolCalls.set(idx, existing);
        }
        if (tc.function?.name) existing.function.name = tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
        callbacks.onToolCallDelta?.(existing);
      }
    }
  }

  return {
    content,
    toolCalls: Array.from(toolCalls.values()),
    usage,
    model: options.model,
  };
}

/** ≈4 chars/token fallback so /usage works even on endpoints that don't report usage. */
function estimateUsage(messages: Message[], result: CompletionResult): TokenUsage {
  let inputChars = 0;
  for (const m of messages) {
    inputChars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  }
  let outputChars = result.content.length + (result.toolCalls ?? []).reduce(
    (n, tc) => n + (tc.function?.name?.length ?? 0) + (tc.function?.arguments?.length ?? 0),
    0
  );
  return {
    inputTokens: Math.round(inputChars / 4),
    outputTokens: Math.round(outputChars / 4),
  };
}

/**
 * True when the SDK error means the active model can't serve the request right
 * now and another model on the same endpoint might. Covers the OpenAI 429
 * shape plus the natural-language variants proxies (Token Harbor, OpenRouter,
 * LiteLLM, ...) return: "quota", "rate limit", "exhausted", "usage limit".
 *
 * Deliberately narrow — a 401 (bad key) or 404 (model gone) is a config
 * problem, not a failover candidate, and retrying would just waste attempts.
 */
export function isQuotaError(e: any): boolean {
  if (e?.status === 429) return true;
  const msg = (e?.message ?? "").toLowerCase();
  return (
    /\bquota\b/.test(msg) ||
    /rate[-_\s]?limit/.test(msg) ||
    /\bexhausted\b/.test(msg) ||
    /usage[-_\s]?limit/.test(msg)
  );
}

/**
 * Discover failover candidates for an endpoint: every model it offers except
 * the active one, `:free` first. Hits the endpoint's `/models` (no chat quota).
 * Returns [] when failover is disabled or nothing can be discovered.
 */
export async function getFailoverCandidates(
  baseURL: string,
  apiKey: string | undefined,
  activeModel: string,
  cfg: FacodeConfig
): Promise<string[]> {
  if (!baseURL) return [];
  const models = await getAvailableModels(baseURL, apiKey);
  if (!models.length) return [];
  const active = activeModel.toLowerCase();
  const free = models.filter(
    (m) => m.toLowerCase() !== active && isFreeModel(m)
  );
  const rest = models.filter(
    (m) =>
      m.toLowerCase() !== active && !isFreeModel(m)
  );
  return selectFailoverCandidates(cfg, [...free, ...rest]);
}

export async function getAvailableModels(baseURL?: string, apiKey?: string): Promise<string[]> {
  try {
    const client = await createClient(baseURL, apiKey);
    const models = await client.models.list();
    return models.data.map((m) => m.id).sort();
  } catch {
    return [];
  }
}

/** Create the streaming completion; enrich 404 "model not available" errors with the live model list. */
async function createStream(
  client: OpenAI,
  messages: Message[],
  options: ProviderOptions,
  tools: ReturnType<typeof toInputSchema>[]
) {
  const baseRequest = {
    model: options.model,
    messages: messages as any,
    tools: tools.length ? (tools as any) : undefined,
    tool_choice: tools.length ? ("auto" as const) : undefined,
    stream: true as const,
    temperature: 0.1,
    ...(options.maxTokens && options.maxTokens < 999_999_999 ? { max_tokens: options.maxTokens } : {}),
  };
  try {
    // Ask the endpoint for real token usage on the final stream chunk.
    // Strict proxies may reject the unknown field — retried below without.
    let stream: any;
    try {
      stream = await (client.chat.completions.create as any)({
        ...baseRequest,
        stream_options: { include_usage: true },
      });
    } catch (se: any) {
      const sm = se?.message ?? String(se);
      if (!/stream_options|include_usage|unknown field|unrecognized/i.test(sm)) throw se;
      stream = await client.chat.completions.create(baseRequest as any);
    }
    return stream;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // Surface the undici/fetch root cause (ECONNRESET, ECONNREFUSED, cert
    // errors...) — "Connection error." alone is undebuggable. The SDK nests
    // the failure: APIConnectionError.cause = TypeError("fetch failed"),
    // whose own .cause holds the real undici error.
    const root = e?.cause?.cause ?? e?.cause;
    const cause = root?.code || root?.message
      ? ` (root cause: ${[root.code, root.message].filter(Boolean).join(" ")})`
      : "";
    if (e?.status === 401 || /invalid_api_key/i.test(msg)) {
      throw new Error(`${msg}${cause}\n${authErrorHint(options.baseURL, options.apiKey)}`);
    }
    if (e?.status === 404 || /model .* not available/i.test(msg)) {
      const available = await getAvailableModels(options.baseURL, options.apiKey);
      const hint = available.length
        ? `Available models:\n  ${available.join("\n  ")}\n\nSet a valid model via FACODE_MODEL, /model <name>, or .facode/config.json.`
        : "(could not list available models)";
      throw new Error(`${msg}\n\n${hint}`);
    }
    throw new Error(`${msg}${cause}`);
  }
}

/** Load provider options from config + env. */
export function getProviderOptions(cwd?: string): ProviderOptions {
  const cfg = loadConfig(cwd);
  const resolved = resolveProviderOptions(cfg);
  if (!resolved.model) {
    // Only custom providers added without a model can land here (built-in
    // presets all carry a default). Fail with actionable guidance instead of
    // a cryptic API 404 later.
    throw new Error(
      [
        "No model configured.",
        "",
        "Set one with:  facode model set <model-name>",
        "List models:   facode provider test <provider-name>  (shows what the endpoint offers)",
        "Or per run:    facode --model <model-name>",
      ].join("\n")
    );
  }
  return {
    model: resolved.model,
    baseURL: resolved.baseURL ?? process.env.OPENAI_BASE_URL,
    apiKey: resolved.apiKey ?? process.env.OPENAI_API_KEY,
    maxTokens: resolved.maxTokens,
  };
}

/** Human-friendly guidance for authentication failures. */
function authErrorHint(baseURL?: string, apiKey?: string): string {
  return [
    "",
    "FA Code could not authenticate with the LLM endpoint.",
    `  endpoint: ${baseURL ?? "(provider default)"}`,
    `  api key:  ${maskKey(apiKey)}`,
    "",
    "Fix it by setting a valid API key for that endpoint:",
    "  • env: FACODE_API_KEY (or OPENAI_API_KEY for the openai preset)",
    "  • or project config: .facode/config.json { apiKey, baseURL, model }",
    "  • or switch provider: facode --provider <name> / /provider <name>",
  ].join("\n");
}
