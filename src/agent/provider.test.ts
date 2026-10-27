import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectFailoverCandidates, type FacodeConfig } from "@/config";
import type { Message } from "@/agent/types";

// The `openai` SDK is loaded lazily inside createClient, so the whole provider
// module is reset per test and the mock below supplies both the chat stream
// and the /models list that failover discovery needs.
vi.mock("openai", () => {
  const state = {
    models: [] as string[],
    /** Model ids that should fail (with the error to throw). */
    failing: new Map<string, { message: string; status?: number }>(),
    streamContent: "ok",
  };
  return {
    default: class MockOpenAI {
      /** Shared test hook — read/write the endpoint's behavior. */
      static __state = state;
      models = {
        list: async () => ({ data: state.models.map((id) => ({ id })) }),
      };
      chat = {
        completions: {
          create: async (opts: { model?: string }) => {
            const fail = opts.model ? state.failing.get(opts.model) : null;
            if (fail) {
              const err = new Error(fail.message);
              if (fail.status !== undefined) (err as any).status = fail.status;
              throw err;
            }
            return (async function* () {
              yield { choices: [{ delta: { content: state.streamContent } }] };
            })();
          },
        },
      };
    },
  };
});

function failoverCfg(overrides: FacodeConfig["failover"] = {}): FacodeConfig {
  return {
    provider: "openai",
    permissionMode: "default",
    maxTokens: 8192,
    contextWindow: 128_000,
    compactionThreshold: 0.8,
    failover: { enabled: true, freeOnly: false, maxAttempts: 3, ...overrides },
  };
}

describe("selectFailoverCandidates", () => {
  it("returns [] when failover is disabled", () => {
    expect(
      selectFailoverCandidates({ ...failoverCfg({ enabled: false }) }, ["a", "b"])
    ).toEqual([]);
  });

  it("caps the list to maxAttempts", () => {
    expect(
      selectFailoverCandidates(failoverCfg({ maxAttempts: 2 }), ["a", "b", "c", "d"])
    ).toEqual(["a", "b"]);
  });

  it("restricts to :free models when freeOnly is set", () => {
    expect(
      selectFailoverCandidates(
        failoverCfg({ freeOnly: true }),
        ["paid-a", "free-a:free", "paid-b", "free-b:free"]
      )
    ).toEqual(["free-a:free", "free-b:free"]);
  });

  it("passes candidates through unchanged when freeOnly is off", () => {
    expect(
      selectFailoverCandidates(failoverCfg(), ["paid-a", "free-a:free", "paid-b"])
    ).toEqual(["paid-a", "free-a:free", "paid-b"]);
  });
});

describe("createCompletion auto-failover", () => {
  beforeEach(() => vi.resetModules());

  async function setup() {
    const mod = await import("@/agent/provider");
    const OpenAI = (await import("openai")).default as any;
    // Reset the shared mock state — the mock factory captures one state object
    // across module resets, so tests must clear it explicitly.
    OpenAI.__state.models = [];
    OpenAI.__state.failing = new Map();
    OpenAI.__state.streamContent = "ok";
    return { mod, state: OpenAI.__state };
  }

  it("switches model and retries after a 429 quota error", async () => {
    const { mod, state } = await setup();
    state.models = ["deepseek-v4.1-flash:free", "nemotron:free", "gpt-4o"];
    state.failing.set("deepseek-v4.1-flash:free", {
      message: "Model deepseek-v4.1-flash:free has exceeded your quota",
      status: 429,
    });
    state.streamContent = "recovered";

    const switches: [string, string][] = [];
    const result = await mod.createCompletion(
      [{ role: "user", content: "hi" }] as Message[],
      {
        baseURL: "https://api.example.com/v1",
        model: "deepseek-v4.1-flash:free",
        failover: {
          candidates: [],
          cfg: failoverCfg(),
          onSwitch: (from, to) => switches.push([from, to]),
        },
      },
      []
    );

    expect(result.content).toBe("recovered");
    expect(switches).toEqual([["deepseek-v4.1-flash:free", "nemotron:free"]]);
  });

  it("prefers :free candidates over paid ones", async () => {
    const { mod, state } = await setup();
    // /models returns paid first — failover must still pick the free one.
    state.models = ["gpt-4o", "nemotron:free", "deepseek-v4.1-flash:free"];
    state.failing.set("deepseek-v4.1-flash:free", {
      message: "rate limit exceeded",
      status: 429,
    });
    state.streamContent = "from-free";

    const switches: [string, string][] = [];
    const result = await mod.createCompletion(
      [{ role: "user", content: "hi" }] as Message[],
      {
        baseURL: "https://api.example.com/v1",
        model: "deepseek-v4.1-flash:free",
        failover: {
          candidates: [],
          cfg: failoverCfg(),
          onSwitch: (from, to) => switches.push([from, to]),
        },
      },
      []
    );

    expect(result.content).toBe("from-free");
    expect(switches).toEqual([["deepseek-v4.1-flash:free", "nemotron:free"]]);
  });

  it("surfaces the original error when no candidates remain", async () => {
    const { mod, state } = await setup();
    // Only the active model exists — nothing to fail over to.
    state.models = ["deepseek-v4.1-flash:free"];
    state.failing.set("deepseek-v4.1-flash:free", {
      message: "quota exceeded",
      status: 429,
    });

    await expect(
      mod.createCompletion(
        [{ role: "user", content: "hi" }] as Message[],
        {
          baseURL: "https://api.example.com/v1",
          model: "deepseek-v4.1-flash:free",
          failover: { candidates: [], cfg: failoverCfg() },
        },
        []
      )
    ).rejects.toThrow("quota exceeded");
  });

  it("does not retry on non-quota errors", async () => {
    const { mod, state } = await setup();
    state.models = ["nemotron:free"];
    state.failing.set("deepseek-v4.1-flash:free", {
      message: "model not found",
      status: 404,
    });

    await expect(
      mod.createCompletion(
        [{ role: "user", content: "hi" }] as Message[],
        {
          baseURL: "https://api.example.com/v1",
          model: "deepseek-v4.1-flash:free",
          failover: { candidates: [], cfg: failoverCfg() },
        },
        []
      )
    ).rejects.toThrow("model not found");
  });

  it("recognizes natural-language quota messages without a status code", async () => {
    const { mod, state } = await setup();
    state.models = ["nemotron:free"];
    // Proxies (Token Harbor, LiteLLM, ...) often return 200 with a body like this.
    state.failing.set("deepseek-v4.1-flash:free", {
      message: "You have exceeded your usage limit.",
    });
    state.streamContent = "switched";

    const switches: [string, string][] = [];
    const result = await mod.createCompletion(
      [{ role: "user", content: "hi" }] as Message[],
      {
        baseURL: "https://api.example.com/v1",
        model: "deepseek-v4.1-flash:free",
        failover: {
          candidates: [],
          cfg: failoverCfg(),
          onSwitch: (from, to) => switches.push([from, to]),
        },
      },
      []
    );

    expect(result.content).toBe("switched");
    expect(switches).toHaveLength(1);
  });

  it("picks -free (OpenCode-style) candidates, not just :free", async () => {
    const { mod, state } = await setup();
    // OpenCode marks free models with a `-free` suffix — the old code only
    // recognized `:free` and would have built an empty candidate list.
    state.models = ["gpt-5.5", "beam-free", "deepseek-v4.1-flash-free", "claude-sonnet-5-5"];
    state.failing.set("gpt-5.5", {
      message: "rate limit exceeded",
      status: 429,
    });
    state.streamContent = "from-free";

    const switches: [string, string][] = [];
    const result = await mod.createCompletion(
      [{ role: "user", content: "hi" }] as Message[],
      {
        baseURL: "https://api.example.com/v1",
        model: "gpt-5.5",
        failover: {
          candidates: [],
          cfg: failoverCfg(),
          onSwitch: (from, to) => switches.push([from, to]),
        },
      },
      []
    );

    expect(result.content).toBe("from-free");
    expect(switches).toEqual([["gpt-5.5", "beam-free"]]);
  });
});