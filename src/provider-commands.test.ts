import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProvider,
  listProviderSetups,
  removeProvider,
  setModel,
  showModel,
  testProvider,
  useProvider,
  interactiveAddProvider,
} from "@/provider-commands";

/**
 * Provider/model management operations. All tests run fully isolated:
 * FACODE_USER_DIR points at a throwaway user dir and the project layer is a
 * throwaway temp dir, so neither the machine's ~/.facode nor the repo's
 * .facode config is touched. Network calls in `testProvider` are stubbed via
 * the global fetch.
 */
describe("provider-commands", () => {
  let userDir = "";
  let project = "";
  const oldUserDir = process.env.FACODE_USER_DIR;
  const oldEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["FACODE_MODEL", "FACODE_BASE_URL", "FACODE_API_KEY", "FACODE_PROVIDER"];

  // A FRESH user dir and project dir per test: tests assert both presence and
  // absence of config files, so shared dirs would leak state between them.
  beforeEach(async () => {
    userDir = await mkdtemp(join(tmpdir(), "facode-user-"));
    process.env.FACODE_USER_DIR = userDir;
    for (const k of ENV_KEYS) {
      oldEnv[k] = process.env[k];
      delete process.env[k];
    }
    project = await mkdtemp(join(tmpdir(), "facode-proj-"));
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (oldEnv[k] === undefined) delete process.env[k];
      else process.env[k] = oldEnv[k];
    }
    if (oldUserDir === undefined) delete process.env.FACODE_USER_DIR;
    else process.env.FACODE_USER_DIR = oldUserDir;
    if (userDir) await rm(userDir, { recursive: true, force: true });
    if (project) await rm(project, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const userCfg = async () =>
    JSON.parse(await readFile(join(userDir, "config.json"), "utf8"));
  const projectCfg = async () =>
    JSON.parse(await readFile(join(project, ".facode", "config.json"), "utf8"));

  describe("addProvider", () => {
    it("saves to the user layer by default and masks the key in output", async () => {
      const out = addProvider({
        name: "myproxy",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "my-model",
      });
      expect(out).toContain('✔ Provider "myproxy" added');
      expect(out).toContain("sk-abcde...1234");
      expect(out).not.toContain("sk-abcdefghijklmnop1234");

      const raw = await userCfg();
      expect(raw.providers.myproxy).toEqual({
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "my-model",
      });
    });

    it("supports --scope project (writes the project layer only)", async () => {
      const out = addProvider({
        name: "projprov",
        baseURL: "https://p.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        scope: "project",
        cwd: project,
      });
      expect(out).toContain("project config");
      const raw = await projectCfg();
      expect(raw.providers.projprov.baseURL).toBe("https://p.example.com/v1");
      // The user layer must stay untouched.
      await expect(readFile(join(userDir, "config.json"), "utf8")).rejects.toThrow();
    });

    it("stores an env-var reference for env-style keys", async () => {
      await addProvider({
        name: "envprov",
        baseURL: "https://e.example.com/v1",
        apiKey: "env:MY_SECRET_VAR",
      });
      const raw = await userCfg();
      expect(raw.providers.envprov.apiKeyEnv).toBe("MY_SECRET_VAR");
      expect(raw.providers.envprov.apiKey).toBe("");
    });

    it("rejects invalid input without writing anything", async () => {
      const badName = addProvider({
        name: "1bad name",
        baseURL: "https://x.example.com/v1",
        apiKey: "k",
      });
      expect(badName).toContain("Invalid provider name");

      const badUrl = addProvider({ name: "ok", baseURL: "nope", apiKey: "k" });
      expect(badUrl).toContain("Invalid base URL");

      const noKey = addProvider({ name: "ok", baseURL: "https://x.example.com/v1" });
      expect(noKey).toContain("Missing API key");

      await expect(readFile(join(userDir, "config.json"), "utf8")).rejects.toThrow();
    });

    it("refuses to overwrite an existing provider in the same layer", async () => {
      await addProvider({
        name: "dup",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      const out = addProvider({
        name: "dup",
        baseURL: "https://b.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      expect(out).toContain('already exists');
      const raw = await userCfg();
      expect(raw.providers.dup.baseURL).toBe("https://a.example.com/v1");
    });
  });

  describe("listProviderSetups", () => {
    it("lists built-ins plus custom providers and marks the active one", () => {
      const out = listProviderSetups(project);
      expect(out).toContain("Providers:");
      expect(out).toContain("openai");
      expect(out).toContain("deepseek");

      addProvider({
        name: "mine",
        baseURL: "https://m.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      useProvider(project, "mine", "user");
      const out2 = listProviderSetups(project);
      expect(out2).toContain("mine");
      expect(out2).toContain("sk-abcde...1234");
      // The active marker is on the mine row, not on openai's.
      const mineLine = out2.split("\n").find((l) => l.includes(" mine "));
      expect(mineLine?.trimStart()[0]).toBe("•");
    });
  });

  describe("useProvider", () => {
    it("errors on an unknown provider", () => {
      expect(useProvider(project, "nope-not-real")).toContain("Unknown provider");
    });

    it("persists activeProvider to the requested layer", async () => {
      addProvider({
        name: "pickme",
        baseURL: "https://u.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "m1",
      });
      const out = useProvider(project, "pickme", "user");
      expect(out).toContain('✔ Active provider set to "pickme"');
      expect(out).toContain("m1");
      const raw = await userCfg();
      expect(raw.activeProvider).toBe("pickme");

      const out2 = useProvider(project, "pickme", "project");
      expect(out2).toContain("project config");
      const praw = await projectCfg();
      expect(praw.activeProvider).toBe("pickme");
    });

    it("warns when the project layer pins a different activeProvider", async () => {
      await mkdir(join(project, ".facode"), { recursive: true });
      await addProvider({
        name: "pinprov",
        baseURL: "https://pin.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        scope: "project",
        cwd: project,
      });
      useProvider(project, "pinprov", "project");
      addProvider({
        name: "other",
        baseURL: "https://o.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      const out = useProvider(project, "other", "user");
      expect(out).toContain('pins activeProvider="pinprov"');
    });
  });

  describe("removeProvider", () => {
    it("removes from the target layer and clears a matching activeProvider", async () => {
      addProvider({
        name: "gone",
        baseURL: "https://g.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      useProvider(project, "gone", "user");
      const out = removeProvider(project, "gone", "user");
      expect(out).toContain('✔ Provider "gone" removed');
      expect(out).toContain("was the active user-level provider");
      const raw = await userCfg();
      expect(raw.providers.gone).toBeUndefined();
      expect(raw.activeProvider).toBeUndefined();
    });

    it("protects built-ins and unknown names", () => {
      const builtin = removeProvider(project, "deepseek", "user");
      expect(builtin).toContain("built-in");

      const unknown = removeProvider(project, "never-added", "user");
      expect(unknown).toContain("Unknown provider");
    });
  });

  describe("testProvider", () => {
    it("reports success with model count on HTTP 200", async () => {
      addProvider({
        name: "live",
        baseURL: "https://live.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const out = await testProvider(project, "live");
      expect(out).toContain("✔ live: endpoint reachable");
      expect(out).toContain("models:   2");
      expect(out).toContain("model-a");
      expect(out).toContain("sk-abcde...1234");
      expect(fetchMock.mock.calls[0][0]).toBe("https://live.example.com/v1/models");
    });

    it("reports the HTTP status and body on failure responses", async () => {
      addProvider({
        name: "bad",
        baseURL: "https://bad.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => "Unauthorized",
        })
      );
      const out = await testProvider(project, "bad");
      expect(out).toContain("✖ bad: HTTP 401");
      expect(out).toContain("Unauthorized");
    });

    it("reports connection failures without throwing", async () => {
      addProvider({
        name: "dead",
        baseURL: "https://dead.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const out = await testProvider(project, "dead");
      expect(out).toContain("✖ dead: connection failed");
      expect(out).toContain("ECONNREFUSED");
    });

    it("trims trailing slashes when building the /models URL", async () => {
      addProvider({
        name: "slashy",
        baseURL: "https://s.example.com/v1/",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      await testProvider(project, "slashy");
      expect(fetchMock.mock.calls[0][0]).toBe("https://s.example.com/v1/models");
    });
  });

  describe("setModel / showModel", () => {
    it("persists to the requested layer and resolves the merged view", async () => {
      const out = setModel(project, "my-model", "user");
      expect(out).toContain('✔ Model set to "my-model"');
      const raw = await userCfg();
      expect(raw.model).toBe("my-model");

      const shown = showModel(project);
      expect(shown).toContain("my-model");
    });

    it("project scope writes only the project layer", async () => {
      setModel(project, "proj-model", "project");
      const praw = await projectCfg();
      expect(praw.model).toBe("proj-model");
      expect(showModel(project)).toContain("proj-model");
    });
  });

  describe("interactiveAddProvider", () => {
    // vitest runs without a TTY, so the interactive path should refuse politely
    // rather than hang on prompts. (In a real terminal it asks for each field.)
    it.runIf(!process.stdin.isTTY)("declines to prompt without a TTY", async () => {
      const out = await interactiveAddProvider({ cwd: project });
      expect(out).toContain("need a terminal (TTY)");
      expect(out).toContain("facode provider add");
    });
  });
});
