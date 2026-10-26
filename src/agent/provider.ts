import type OpenAI from "openai";
import type { Role, Message, ToolCall, StreamCallbacks } from "@/agent/types";
import { toInputSchema } from "@/tools/types";
import { loadConfig, maskKey, resolveProviderOptions } from "@/config";

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
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
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

  const stream = await createStream(client, messages, options, tools);

  let content = "";
  const toolCalls: Map<number, ToolCall> = new Map();
  let reasoningContent = "";

  for await (const chunk of stream) {
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
    usage: undefined, // stream doesn't return usage
  };
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
  try {
    return await client.chat.completions.create({
      model: options.model,
      messages: messages as any,
      tools: tools.length ? (tools as any) : undefined,
      tool_choice: tools.length ? ("auto" as const) : undefined,
      max_tokens: options.maxTokens ?? 8192,
      stream: true,
      temperature: 0.1,
    });
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