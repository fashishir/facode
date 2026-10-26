import { describe, it, expect, vi } from "vitest";
import { runAgentLoop } from "@/agent/loop";

describe("Agent Loop", () => {
  it("should run a simple conversation", async () => {
    // Mock the completion and tools
    vi.mock("@/agent/provider", () => ({
      createCompletion: vi.fn().mockResolvedValue({
        content: "Hello, I am FA Code.",
        toolCalls: [],
      }),
      getProviderOptions: vi.fn().mockReturnValue({ model: "test-model" }),
    }));

    const result = await runAgentLoop("Hi", [], {
      cwd: process.cwd(),
      systemPrompt: "You are helpful.",
    } as any);

    expect(result.lastResponse).toBe("Hello, I am FA Code.");
  });
});