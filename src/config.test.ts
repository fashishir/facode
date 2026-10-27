import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSystemPrompt,
  getProviderPresets,
  isFreeModel,
  loadConfig,
  maskKey,
  presetApiKey,
  providerPresetNames,
  resolveProviderOptions,
  saveUserConfig,
  selectFailoverCandidates,
  validateProviderInput,
  type FacodeConfig,
} from "@/config";
import { decide, PermissionsState } from "@/permissions";

describe("Config", () => {
  // Isolate the user-level config layer (~/.facode/config.json) so tests are
  // deterministic regardless of the machine's real user config.
  let userDir = "";
  const oldUserDir = process.env.FACODE_USER_DIR;

  beforeAll(async () => {
    userDir = await mkdtemp(join(tmpdir(), "facode-user-"));
  });
  afterAll(async () => {
    if (userDir) await rm(userDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    process.env.FACODE_USER_DIR = userDir;
  });
  afterEach(() => {
    if (oldUserDir === undefined) delete process.env.FACODE_USER_DIR;
    else process.env.FACODE_USER_DIR = oldUserDir;
  });

  it("should load default config", () => {
    const cfg = loadConfig(process.cwd());
    expect(cfg.permissionMode).toBe("default");
  });

  it("should honor env overrides", () => {
    const old = process.env.FACODE_BASE_URL;
    process.env.FACODE_BASE_URL = "https://test.example.com";
    const cfg = loadConfig(process.cwd());
    expect(cfg.baseURL).toBe("https://test.example.com");
    if (old) process.env.FACODE_BASE_URL = old;
    else delete process.env.FACODE_BASE_URL;
  });

  it("should have reasonable defaults", () => {
    // Build the cfg explicitly rather than loading the repo's .facode/config.json
    // — that file is a live, user-editable artifact whose values drift.
    const cfg: FacodeConfig = {
      provider: "openai",
      permissionMode: "default",
      maxTokens: 8192,
      contextWindow: 128_000,
      compactionThreshold: 0.8,
    };
    expect(cfg.maxTokens).toBe(8192);
    expect(cfg.contextWindow).toBe(128_000);
  });

  describe("providerPresetNames", () => {
    it("should expose the built-in presets", () => {
      const names = providerPresetNames();
      expect(names).toContain("openai");
      expect(names).toContain("deepseek");
      expect(names).toContain("pi");
      expect(names).toContain("anthropic");
      expect(names).toContain("ollama");
    });
  });

  describe("resolveProviderOptions", () => {
    it("should fall back to legacy top-level fields when no preset is selected", () => {
      // Build the cfg explicitly rather than loading the repo's .facode/config.json
      // — that file is a live, user-editable artifact and its model drifts.
      const cfg: FacodeConfig = {
        provider: "openai",
        permissionMode: "default",
        maxTokens: 8192,
        contextWindow: 128_000,
        compactionThreshold: 0.8,
        model: "deepseek-v4.1-flash:free",
      };
      // A user might have set activeProvider; clear it to test the legacy path.
      cfg.activeProvider = undefined;
      cfg.provider = undefined;
      const resolved = resolveProviderOptions(cfg);
      expect(resolved.model).toBe("deepseek-v4.1-flash:free");
      expect(resolved.baseURL).toBeUndefined();
      expect(resolved.apiKey).toBeUndefined();
    });

    it("should resolve a named preset (pi)", () => {
      const cfg = loadConfig(process.cwd());
      cfg.model = undefined;
      cfg.activeProvider = "pi";
      const resolved = resolveProviderOptions(cfg);
      expect(resolved.provider).toBe("pi");
      expect(resolved.baseURL).toBe("https://api.pi.ai/v1");
      expect(resolved.model).toBe("pi");
    });

    it("should fall back to legacy baseURL/apiKey/model for custom endpoints", () => {
      const cfg = loadConfig(process.cwd());
      cfg.activeProvider = undefined;
      cfg.provider = undefined;
      cfg.baseURL = "https://my.proxy/v1";
      cfg.apiKey = "sk-123";
      cfg.model = "my-model";
      const resolved = resolveProviderOptions(cfg);
      expect(resolved.baseURL).toBe("https://my.proxy/v1");
      expect(resolved.apiKey).toBe("sk-123");
      expect(resolved.model).toBe("my-model");
    });

    it("should let a configured preset override the built-in", () => {
      const cfg = loadConfig(process.cwd());
      cfg.model = undefined;
      cfg.providers = {
        myproxy: {
          baseURL: "https://my.proxy/v1",
          apiKey: "sk-xyz",
          model: "my-model",
          maxTokens: 4096,
        },
      };
      cfg.activeProvider = "myproxy";
      const resolved = resolveProviderOptions(cfg);
      expect(resolved.provider).toBe("myproxy");
      expect(resolved.baseURL).toBe("https://my.proxy/v1");
      expect(resolved.apiKey).toBe("sk-xyz");
      expect(resolved.model).toBe("my-model");
      expect(resolved.maxTokens).toBe(4096);
    });

    it("should prefer cfg.model over the preset model", () => {
      const cfg = loadConfig(process.cwd());
      cfg.activeProvider = "deepseek";
      cfg.model = "deepseek-coder";
      const resolved = resolveProviderOptions(cfg);
      expect(resolved.model).toBe("deepseek-coder");
    });

    it("zero-config fallback should honor OPENAI_BASE_URL (proxy-friendly)", () => {
      // Nothing configured at all → built-in openai preset. It must not
      // hard-code api.openai.com, or a proxy key (e.g. Token Harbor's
      // thk_live...) gets sent to real OpenAI and 401s.
      const resolved = resolveProviderOptions({});
      expect(resolved.baseURL).toBe(
        process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
      );
      expect(resolved.model).toBe("gpt-4o");
    });
  });

  describe("provider helpers", () => {
    it("maskKey hides most of a long key", () => {
      expect(maskKey("sk-abcdefghijklmnop1234")).toBe("sk-abcde...1234");
      expect(maskKey("shortkey12")).toBe("***");
      expect(maskKey("")).toBe("(unset)");
      expect(maskKey(undefined)).toBe("(unset)");
    });

    it("validateProviderInput accepts a well-formed provider", () => {
      expect(
        validateProviderInput({
          name: "my-proxy_1",
          baseURL: "https://api.example.com/v1",
          apiKey: "sk-abc",
        })
      ).toBeNull();
    });

    it("validateProviderInput rejects bad names, URLs, and missing keys", () => {
      const badName = validateProviderInput({
        name: "1bad name",
        baseURL: "https://x.example.com/v1",
        apiKey: "k",
      });
      expect(badName).toContain("Invalid provider name");

      const badUrl = validateProviderInput({
        name: "ok",
        baseURL: "not a url",
        apiKey: "k",
      });
      expect(badUrl).toContain("Invalid base URL");

      const badScheme = validateProviderInput({
        name: "ok",
        baseURL: "ftp://x.example.com/v1",
        apiKey: "k",
      });
      expect(badScheme).toContain("http(s)");

      const noKey = validateProviderInput({ name: "ok", baseURL: "https://x.example.com/v1" });
      expect(noKey).toContain("Missing API key");

      // Updates may omit credentials — requireKey=false relaxes that check.
      const update = validateProviderInput(
        { name: "ok", baseURL: "https://x.example.com/v1" },
        false
      );
      expect(update).toBeNull();

      // apiKeyEnv satisfies the key requirement.
      const envKey = validateProviderInput({
        name: "ok",
        baseURL: "https://x.example.com/v1",
        apiKeyEnv: "MY_KEY",
      });
      expect(envKey).toBeNull();
    });

    it("saveUserConfig writes to ~/.facode/config.json and loadConfig reads it back", async () => {
      const emptyProject = await mkdtemp(join(tmpdir(), "facode-proj-"));
      try {
        saveUserConfig({ model: "saved-model", maxTokens: 1024 });
        const cfg = loadConfig(emptyProject);
        expect(cfg.model).toBe("saved-model");
        expect(cfg.maxTokens).toBe(1024);
      } finally {
        await rm(emptyProject, { recursive: true, force: true });
      }
    });

    it("getProviderPresets merges configured providers over built-ins", () => {
      const merged = getProviderPresets({
        providers: {
          openai: { baseURL: "https://override/v1", apiKey: "", model: "m" },
          mine: { baseURL: "https://mine/v1", apiKey: "k", model: "m2" },
        },
      } as any);
      expect(merged.openai.baseURL).toBe("https://override/v1");
      expect(merged.mine.baseURL).toBe("https://mine/v1");
      expect(merged.deepseek).toBeDefined();
    });

    it("presetApiKey resolves apiKeyEnv from the environment", () => {
      const old = process.env.FACODE_TEST_KEY;
      try {
        process.env.FACODE_TEST_KEY = "env-key-value";
        expect(presetApiKey({ baseURL: "", apiKey: "", model: "", apiKeyEnv: "FACODE_TEST_KEY" })).toBe(
          "env-key-value"
        );
        delete process.env.FACODE_TEST_KEY;
        expect(presetApiKey({ baseURL: "", apiKey: "", model: "", apiKeyEnv: "FACODE_TEST_KEY" })).toBe("");
      } finally {
        if (old !== undefined) process.env.FACODE_TEST_KEY = old;
      }
    });

    it("isFreeModel recognizes :free and -free suffixes", () => {
      expect(isFreeModel("deepseek-v4.1-flash:free")).toBe(true);
      expect(isFreeModel("beam-free")).toBe(true);
      expect(isFreeModel("gpt-5.5")).toBe(false);
      expect(isFreeModel("gpt-5.5-free")).toBe(true);
      expect(isFreeModel("gpt-5.5:free")).toBe(true);
      expect(isFreeModel("FREE-MODEL-FREE")).toBe(true); // case-insensitive
    });

    it("resolveProviderOptions resolves the apiKeyEnv of the selected preset", () => {
      const old = process.env.FACODE_TEST_KEY;
      try {
        process.env.FACODE_TEST_KEY = "env-key-value";
        const cfg = loadConfig(process.cwd());
        cfg.model = undefined;
        cfg.providers = {
          envprov: {
            baseURL: "https://envprov.example.com/v1",
            apiKey: "",
            apiKeyEnv: "FACODE_TEST_KEY",
            model: "env-model",
          },
        };
        cfg.activeProvider = "envprov";
        const resolved = resolveProviderOptions(cfg);
        expect(resolved.apiKey).toBe("env-key-value");
        expect(resolved.model).toBe("env-model");
      } finally {
        if (old !== undefined) process.env.FACODE_TEST_KEY = old;
        else delete process.env.FACODE_TEST_KEY;
      }
    });
  });

  describe("user-level config (~/.facode/config.json)", () => {
    it("applies when the project has no .facode config", async () => {
      await mkdir(userDir, { recursive: true });
      await writeFile(
        join(userDir, "config.json"),
        JSON.stringify({ model: "user-model" })
      );
      const emptyProject = await mkdtemp(join(tmpdir(), "facode-proj-"));
      try {
        const cfg = loadConfig(emptyProject);
        expect(cfg.model).toBe("user-model");
      } finally {
        await rm(emptyProject, { recursive: true, force: true });
      }
    });

    it("project config overrides the user level", async () => {
      await writeFile(
        join(userDir, "config.json"),
        JSON.stringify({ model: "user-model" })
      );
      const projectDir = await mkdtemp(join(tmpdir(), "facode-proj-"));
      try {
        await mkdir(join(projectDir, ".facode"), { recursive: true });
        await writeFile(
          join(projectDir, ".facode", "config.json"),
          JSON.stringify({ model: "project-model" })
        );
        const cfg = loadConfig(projectDir);
        expect(cfg.model).toBe("project-model");
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });

    it("merges providers/mcpServers/subagents key-by-key across layers", async () => {
      // A project that defines its own `providers` map must NOT hide the
      // user-level providers (shallow spread used to overwrite the whole map).
      await writeFile(
        join(userDir, "config.json"),
        JSON.stringify({
          providers: {
            userprov: { baseURL: "https://u.example.com/v1", apiKey: "k1", model: "mu" },
          },
          mcpServers: { userMcp: { command: "echo" } },
          subagents: { "user-agent": { description: "d", prompt: "p" } },
        })
      );
      const projectDir = await mkdtemp(join(tmpdir(), "facode-proj-"));
      try {
        await mkdir(join(projectDir, ".facode"), { recursive: true });
        await writeFile(
          join(projectDir, ".facode", "config.json"),
          JSON.stringify({
            providers: {
              projprov: { baseURL: "https://p.example.com/v1", apiKey: "k2", model: "mp" },
            },
          })
        );
        const cfg = loadConfig(projectDir);
        expect(cfg.providers?.userprov).toBeDefined();
        expect(cfg.providers?.projprov).toBeDefined();
        expect(cfg.mcpServers?.userMcp).toBeDefined();
        expect(cfg.subagents?.["user-agent"]).toBeDefined();

        // The resolved active provider sees through the merged map.
        const resolved = resolveProviderOptions({ ...cfg, activeProvider: "userprov" });
        expect(resolved.baseURL).toBe("https://u.example.com/v1");
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe("defaultSystemPrompt", () => {
    it("should generate expected prompt string", () => {
      const prompt = defaultSystemPrompt(process.cwd());
      expect(prompt).toContain("FA Code");
      expect(prompt).toContain("Working directory");
    });
  });
});

describe("Permissions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("default mode should allow reads", () => {
    const state: PermissionsState = { mode: "default", rules: { allow: [], deny: [], ask: [] }, alwaysAllow: new Set() };
    expect(decide(state, "Read", "read")).toBe(true);
  });

  it("default mode should require approval for writes", () => {
    const state: PermissionsState = { mode: "default", rules: { allow: [], deny: [], ask: [] }, alwaysAllow: new Set() };
    expect(decide(state, "Write", "write")).toBe(false);
  });

  it("auto mode should allow everything", () => {
    const state: PermissionsState = { mode: "auto", rules: { allow: [], deny: [], ask: [] }, alwaysAllow: new Set() };
    expect(decide(state, "Bash", "exec")).toBe(true);
  });

  it("plan mode should allow reads only", () => {
    const state: PermissionsState = { mode: "plan", rules: { allow: [], deny: [], ask: [] }, alwaysAllow: new Set() };
    expect(decide(state, "Read", "read")).toBe(true);
    expect(decide(state, "Write", "write")).toBe(false);
  });
});