import type { ZodType } from "zod";

export type PermissionLevel = "read" | "write" | "exec" | "none";

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Emit a progress/note to the UI. */
  notify?: (msg: string) => void;
  /** Permission resolver: returns true if the call may proceed. */
  askPermission?: (tool: string, input: unknown, level: PermissionLevel) => Promise<boolean>;
}

export interface Tool<T = unknown> {
  name: string;
  description: string;
  schema: ZodType<T>;
  /** Raw JSON Schema to send to the model instead of converting `schema` (used by MCP tools). */
  jsonSchema?: Record<string, unknown>;
  permission: PermissionLevel;
  execute(ctx: ToolContext, input: T): Promise<ToolResult>;
}

export interface ToolResult {
  output: string;
  error?: boolean;
  details?: unknown;
}

export function makeTool<T>(t: Tool<T>): Tool<T> {
  return t;
}

/** Convert a Zod schema to an OpenAI-compatible JSON schema (best effort). */
export function toInputSchema<T>(schema: ZodType<T>): Record<string, unknown> {
  const def: any = (schema as any)?._def;
  // If it's a ZodObject, build a proper object schema with properties
  if (def?.typeName === "ZodObject" && def.shape) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(def.shape) as [string, ZodType<any>][]) {
      props[k] = zodToJson(v);
      if (!(v as any).isOptional?.()) required.push(k);
    }
    return {
      type: "object",
      properties: props,
      ...(required.length ? { required } : {}),
    };
  }
  // Otherwise, return the JSON schema for the underlying type
  return zodToJson(schema);
}

function zodToJson(schema: ZodType<any>): Record<string, unknown> {
  const def: any = (schema as any)?._def;
  const t = def?.typeName;
  switch (t) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray":
      return { type: "array", items: zodToJson(def.type) };
    case "ZodObject":
      return { type: "object", properties: {} };
    case "ZodOptional":
    case "ZodDefault":
      return zodToJson(def.innerSchema ?? def.type);
    case "ZodEnum":
      return { type: "string", enum: def.values };
    case "ZodLiteral":
      return { type: typeof def.value, enum: [def.value] };
    default:
      return { type: "string" };
  }
}