import { describe, it, expect, beforeEach } from "vitest";
import {
  TOKEN_BUDGET_PER_MODEL,
  budgetRatio,
  getBudgetForModel,
  getTotalTokensUsed,
  getUsageSnapshot,
  recordUsage,
  resetUsage,
} from "@/agent/usage";

beforeEach(() => resetUsage());

describe("per-model token usage tracker", () => {
  it("accumulates usage per model across requests", () => {
    recordUsage("deepseek-v4.1-flash:free", { inputTokens: 100, outputTokens: 50 });
    recordUsage("deepseek-v4.1-flash:free", { inputTokens: 200, outputTokens: 80 });
    recordUsage("gpt-4o", { inputTokens: 10, outputTokens: 5 });

    const snap = getUsageSnapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toMatchObject({
      model: "deepseek-v4.1-flash:free",
      inputTokens: 300,
      outputTokens: 130,
      requests: 2,
      estimated: false,
    });
    expect(snap[1]).toMatchObject({ model: "gpt-4o", inputTokens: 10, outputTokens: 5, requests: 1 });
  });

  it("counts requests without reported usage and flags them estimated", () => {
    recordUsage("m1", { inputTokens: 10, outputTokens: 5 });
    // No server usage → estimate fallback passed as the third arg.
    recordUsage("m1", undefined, { inputTokens: 999, outputTokens: 1 });

    const [e] = getUsageSnapshot();
    expect(e.requests).toBe(2);
    expect(e.estimated).toBe(true);
    expect(e.inputTokens).toBe(10 + 999);
  });

  it("only flags estimated when at least one request lacked real usage", () => {
    recordUsage("m1", undefined, { inputTokens: 1, outputTokens: 0 });
    recordUsage("m1", { inputTokens: 1, outputTokens: 0 });
    expect(getUsageSnapshot()[0].estimated).toBe(true);

    resetUsage();
    recordUsage("m2", { inputTokens: 1, outputTokens: 0 });
    recordUsage("m2", { inputTokens: 1, outputTokens: 0 });
    expect(getUsageSnapshot()[0].estimated).toBe(false);
  });

  it("tracks the model that actually served the request after failover", () => {
    recordUsage("primary", { inputTokens: 1, outputTokens: 1 });
    recordUsage("fallback:free", { inputTokens: 2, outputTokens: 2 });
    const snap = getUsageSnapshot();
    expect(snap.map((e) => e.model)).toEqual(["primary", "fallback:free"]);
  });

  it("exposes totals and the 1M per-model budget", () => {
    expect(TOKEN_BUDGET_PER_MODEL).toBe(1_000_000);
    expect(getBudgetForModel("anything")).toBe(1_000_000);

    recordUsage("a", { inputTokens: 40, outputTokens: 10 });
    recordUsage("b", { inputTokens: 30, outputTokens: 20 });
    expect(getTotalTokensUsed()).toBe(100);

    const [a] = getUsageSnapshot();
    expect(budgetRatio(a)).toBe(50 / TOKEN_BUDGET_PER_MODEL);
  });

  it("resetUsage clears every counter", () => {
    recordUsage("a", { inputTokens: 1, outputTokens: 1 });
    resetUsage();
    expect(getUsageSnapshot()).toEqual([]);
    expect(getTotalTokensUsed()).toBe(0);
  });
});
