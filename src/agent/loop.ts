import type { Message, ToolCall, ToolResult } from "@/agent/types";
import type { Tool, ToolContext } from "@/tools/types";
import { ToolRegistry } from "@/tools/registry";
import { createCompletion, getProviderOptions } from "@/agent/provider";
import { loadConfig } from "@/config";
import { toInputSchema } from "@/tools/types";

export interface LoopOptions {
  cwd: string;
  systemPrompt: string;
  /**
   * Tools available to the agent (builtins + MCP). May also be a getter
   * resolved once per turn — used so a still-connecting MCP server's tools
   * appear on later turns without blocking first paint at startup.
   * When omitted, the builtin registry filtered by `allowedTools` is used.
   */
  tools?: Tool<any>[] | (() => Tool<any>[]);
  allowedTools?: string[];
  /** Called when a tool is about to execute. Return true to allow, false to deny. */
  permissionGate?: (tool: string, input: unknown, level: string) => Promise<boolean>;
  /** Called for each tool result after execution. */
  onToolResult?: (tool: string, result: ToolResult, callId?: string) => void;
  /** Called on streaming text delta. */
  onDelta?: (delta: string) => void;
  /** Called on streaming reasoning delta (thinking models). */
  onReasoningDelta?: (delta: string) => void;
  /** Called when the assistant produces or updates a tool call. */
  onToolCall?: (call: ToolCall) => void;
  /**
   * Called when auto-failover switches the active model mid-turn (the previous
   * model hit a quota/rate-limit error). Lets the host surface it in the UI.
   */
  onModelSwitch?: (from: string, to: string) => void;
  /** Called when the turn ends (content + tools done). */
  onTurnEnd?: (messages: Message[]) => void;
  /** Abort signal for the whole loop. */
  signal?: AbortSignal;
}

/**
 * The core agent loop:
 * 1. Build message history + system prompt
 * 2. Call provider with available tools
 * 3. Execute any tool calls (with permission gating)
 * 4. Feed tool results back as `role: "tool"` messages
 * 5. Repeat until no tool calls remain (unlimited turns)
 */
export async function runAgentLoop(
  userInput: string,
  history: Message[],
  opts: LoopOptions
): Promise<{ messages: Message[]; lastResponse: string }> {
  const {
    cwd,
    systemPrompt,
    tools: injectedTools,
    allowedTools,
    permissionGate,
    onToolResult,
    onDelta,
    onReasoningDelta,
    onToolCall,
    onTurnEnd,
    onModelSwitch,
    signal,
  } = opts;

  const registry = new ToolRegistry();
  const resolveTools = (): Tool<any>[] => {
    if (typeof injectedTools === "function") return injectedTools();
    return injectedTools ?? registry.filter(allowedTools);
  };
  const tools = resolveTools();
  const toolSchemas = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema ?? toInputSchema(t.schema),
    },
  }));

  const messages: Message[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push(...history, { role: "user", content: userInput });

  const lookupTool = (name: string): Tool<any> | undefined => {
    if (injectedTools) {
      return resolveTools().find((t) => t.name === name);
    }
    return registry.get(name);
  };

  const providerOpts = getProviderOptions(cwd);

  // Auto-failover: when the active model hits a quota/rate-limit error, FA Code
  // silently switches to another model on the same endpoint and retries, so a
  // free-tier cap never kills a session. The switch is in-memory for the turn
  // only — the configured model is untouched, so a fresh session starts clean.
  const cfg = loadConfig(cwd);
  providerOpts.failover = {
    candidates: [],
    cfg,
    onSwitch: onModelSwitch,
  };

  // Unlimited turns — the loop runs until the model stops calling tools
  for (;;) {
    if (signal?.aborted) {
      const abortMsg: Message = {
        role: "assistant",
        content: "[Interrupted by user]",
      };
      messages.push(abortMsg);
      onTurnEnd?.(messages);
      return { messages, lastResponse: "[Interrupted by user]" };
    }

    const { content, toolCalls } = await createCompletion(messages, providerOpts, toolSchemas, {
      onDelta,
      onReasoningDelta,
      onToolCallDelta: onToolCall as (tc: Partial<any>) => void,
    });

    // Preserve the assistant message INCLUDING tool_calls — the OpenAI tool
    // protocol requires tool results to follow an assistant message that
    // carries the corresponding tool_calls.
    if (content || toolCalls.length) {
      messages.push({
        role: "assistant",
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }

    if (!toolCalls.length) {
      // No tools called — turn complete
      onTurnEnd?.(messages);
      return { messages, lastResponse: content ?? "" };
    }

    // Execute tool calls
    const toolResults: Message[] = [];
    for (const call of toolCalls) {
      if (signal?.aborted) break;

      const tool = lookupTool(call.function.name);
      if (!tool) {
        const errContent = `Error: Unknown tool "${call.function.name}"`;
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: errContent,
          name: call.function.name,
        });
        onToolResult?.(call.function.name, { output: errContent, error: true }, call.id);
        continue;
      }

      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        const errContent = `Error: Invalid JSON arguments: ${call.function.arguments}`;
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: errContent,
          name: call.function.name,
        });
        onToolResult?.(call.function.name, { output: errContent, error: true }, call.id);
        continue;
      }

      // Notify caller of tool execution start
      onToolCall?.(call);

      // Permission gate
      const allowed = await permissionGate?.(call.function.name, args, tool.permission);
      if (allowed === false) {
        const deniedMsg = `Permission denied by user for ${call.function.name}`;
        toolResults.push({
          role: "tool",
          tool_call_id: call.id,
          content: deniedMsg,
          name: call.function.name,
        });
        onToolResult?.(call.function.name, { output: deniedMsg, error: true }, call.id);
        continue;
      }

      // Execute
      const ctx: ToolContext = {
        cwd,
        signal,
        askPermission: permissionGate,
      };
      let result: ToolResult;
      try {
        result = await tool.execute(ctx, args);
      } catch (e: any) {
        result = { output: `Tool error: ${e?.message ?? String(e)}`, error: true };
      }
      toolResults.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.output,
        name: call.function.name,
      });
      onToolResult?.(call.function.name, result, call.id);
    }

    messages.push(...toolResults);
  }
}
