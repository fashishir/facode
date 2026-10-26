export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON
  };
}

export interface Message {
  role: Role;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Optional metadata not sent to the LLM */
  _meta?: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  error?: boolean;
  details?: unknown;
}

export interface StreamCallbacks {
  onDelta?: (delta: string) => void;
  onToolCallDelta?: (toolCall: Partial<ToolCall>) => void;
  onReasoningDelta?: (thinking: string) => void;
}