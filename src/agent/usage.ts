/**
 * Per-model token usage tracker.
 *
 * Design (v0.4.4):
 * - FA Code never enforces a usage limit — every request is always allowed.
 *   The 1,000,000 token budget per model is a *tracking reference* only, so
 *   the user can see how much of it each model has consumed.
 * - Counters accumulate for the lifetime of the facode process (one session),
 *   per model. Models are keyed by the id the endpoint actually served the
 *   request with (auto-failover switches are counted under the new model).
 * - Real usage comes from the streaming response when the endpoint reports it
 *   (`stream_options.include_usage`). When an endpoint doesn't report usage,
 *   tokens are estimated from character counts (≈4 chars/token) and the
 *   affected model's entry is flagged `estimated`.
 */

/** Tracking-only budget reference per model — never used to block requests. */
export const TOKEN_BUDGET_PER_MODEL = 1_000_000;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelUsageEntry extends TokenUsage {
  /** Model id exactly as the endpoint served it. */
  model: string;
  /** Number of completion requests made to this model. */
  requests: number;
  /** True when any request for this model lacked server-reported usage. */
  estimated: boolean;
}

const usageByModel = new Map<string, ModelUsageEntry>();

function canonicalModel(model: string): string {
  // Conservative normalization: failover picks variants of the same base id;
  // counting under the canonical id keeps one row per logical model.
  return model.toLowerCase();
}

/**
 * Record one completion request against `model`. `usage` is omitted when the
 * endpoint did not report usage — the request is still counted and tokens are
 * estimated from character counts by the caller (provider.ts).
 */
export function recordUsage(
  model: string,
  usage?: TokenUsage,
  estimate?: TokenUsage
): ModelUsageEntry {
  const key = canonicalModel(model);
  let entry = usageByModel.get(key);
  if (!entry) {
    entry = { model, inputTokens: 0, outputTokens: 0, requests: 0, estimated: false };
    usageByModel.set(key, entry);
  }
  entry.requests += 1;
  const tokens = usage ?? estimate;
  if (tokens) {
    entry.inputTokens += tokens.inputTokens;
    entry.outputTokens += tokens.outputTokens;
  }
  if (!usage) entry.estimated = true;
  return entry;
}

/** Snapshot of all per-model usage, ordered by first use in the session. */
export function getUsageSnapshot(): ModelUsageEntry[] {
  return Array.from(usageByModel.values());
}

/** Total tokens (input + output) consumed across every model this session. */
export function getTotalTokensUsed(): number {
  let total = 0;
  for (const e of usageByModel.values()) total += e.inputTokens + e.outputTokens;
  return total;
}

/** The per-model budget reference — exists for display/tests, never enforcement. */
export function getBudgetForModel(_model: string): number {
  return TOKEN_BUDGET_PER_MODEL;
}

/** Ratio 0..∞ of the model's usage against its 1M tracking budget. */
export function budgetRatio(entry: ModelUsageEntry): number {
  return (entry.inputTokens + entry.outputTokens) / TOKEN_BUDGET_PER_MODEL;
}

/** Clear all counters (used by tests and /usage reset). */
export function resetUsage(): void {
  usageByModel.clear();
}
