import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ToolRegistry } from "@/tools/registry";
import { makeTool, type ToolContext, type ToolResult } from "@/tools/types";
import { z } from "zod";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("should register built-in tools", () => {
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("Bash");
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Edit");
    expect(names).toContain("Glob");
    expect(names).toContain("Grep");
  });

  it("should get a tool by name", () => {
    const bash = registry.get("Bash");
    expect(bash).toBeDefined();
    expect(bash?.name).toBe("Bash");
  });

  it("should return undefined for unknown tool", () => {
    expect(registry.get("Nonexistent")).toBeUndefined();
  });

  it("should filter tools by allowed list", () => {
    const filtered = registry.filter(["Read", "Grep"]);
    const names = filtered.map((t) => t.name);
    expect(names).toContain("Read");
    expect(names).toContain("Grep");
    expect(names).not.toContain("Bash");
  });

  it("should allow wildcard filter", () => {
    const filtered = registry.filter(["*"]);
    expect(filtered.length).toBeGreaterThan(0);
  });

  it("should allow custom tools", () => {
    const custom = makeTool({
      name: "CustomTool",
      description: "A custom tool",
      schema: z.object({ value: z.string() }),
      permission: "read",
      async execute(_ctx: ToolContext, _input: { value: string }): Promise<ToolResult> {
        return { output: `Custom: ${_input.value}` };
      },
    });
    registry.register(custom);
    expect(registry.get("CustomTool")).toBeDefined();
  });
});