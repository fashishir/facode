import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProvider,
  getModelChoices,
  listProviderModels,
  listProviderSetups,
  pickModel,
  providerChoices,
  removeProvider,
  resolvePickAnswer,
  setModel,
  showModel,
  testProvider,
  updateProvider,
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
      // The refusal points at both remediation paths.
      expect(out).toContain("facode provider set dup");
      expect(out).toContain("--force");
    });

    it("overwrites an existing provider with --force", async () => {
      await addProvider({
        name: "dup",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "old-model",
      });
      const out = addProvider({
        name: "dup",
        baseURL: "https://b.example.com/v1",
        apiKey: "env:FRESH_VAR",
        model: "new-model",
        force: true,
      });
      expect(out).toContain('overwritten in');
      const raw = await userCfg();
      expect(Object.keys(raw.providers)).toEqual(["dup"]);
      expect(raw.providers.dup).toEqual({
        baseURL: "https://b.example.com/v1",
        apiKeyEnv: "FRESH_VAR",
        apiKey: "",
        model: "new-model",
      });
    });
  });

  describe("updateProvider", () => {
    it("updates only the passed fields (partial update keeps key + model)", async () => {
      await addProvider({
        name: "up",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "keep-me",
      });
      const out = updateProvider({ name: "up", baseURL: "https://b.example.com/v1" });
      expect(out).toContain('✔ Provider "up" updated in');
      // New URL shown; the stored plaintext key is untouched and never printed.
      expect(out).toContain("https://b.example.com/v1");
      expect(out).toContain("sk-abcde...1234");
      expect(out).not.toContain("sk-abcdefghijklmnop1234");
      const raw = await userCfg();
      expect(raw.providers.up).toEqual({
        baseURL: "https://b.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "keep-me",
      });
    });

    it("changes key + model when passed (old plaintext key fully cleared)", async () => {
      await addProvider({
        name: "full",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-oldoldoldoldold456",
      });
      const out = updateProvider({
        name: "full",
        baseURL: "https://b.example.com/v1",
        apiKey: "sk-newnewnewnewnew456",
        model: "new-model",
      });
      expect(out).toContain("updated in");
      const raw = await userCfg();
      expect(JSON.stringify(raw)).not.toContain("sk-oldoldoldoldold456");
      expect(raw.providers.full.apiKey).toBe("sk-newnewnewnewnew456");
      expect(raw.providers.full.baseURL).toBe("https://b.example.com/v1");
      expect(raw.providers.full.model).toBe("new-model");
    });

    it("env: key update stores a reference and clears the plaintext", async () => {
      await addProvider({
        name: "envup",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      const out = updateProvider({ name: "envup", apiKey: "env:ROTATED_VAR" });
      expect(out).toContain("env:ROTATED_VAR");
      const raw = await userCfg();
      expect(raw.providers.envup.apiKeyEnv).toBe("ROTATED_VAR");
      expect(raw.providers.envup.apiKey).toBe("");
      expect(JSON.stringify(raw)).not.toContain("sk-abcdefghijklmnop1234");
    });

    it("keeps the model and URL when only the key changes", async () => {
      await addProvider({
        name: "keyonly",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "stable-model",
      });
      await updateProvider({ name: "keyonly", apiKey: "sk-newkeynewkey1234" });
      const raw = await userCfg();
      expect(raw.providers.keyonly.model).toBe("stable-model");
      expect(raw.providers.keyonly.baseURL).toBe("https://a.example.com/v1");
    });

    it("refuses built-in presets with a hint", async () => {
      const out = updateProvider({ name: "openai", baseURL: "https://evil.example.com/v1" });
      expect(out).toContain("built-in and cannot be modified");
      expect(out).toContain("provider add");
      // Nothing was written.
      await expect(readFile(join(userDir, "config.json"), "utf8")).rejects.toThrow();
    });

    it("errors on unknown names, listing what IS registered", async () => {
      await addProvider({
        name: "real",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      const out = updateProvider({ name: "ghost", baseURL: "https://x.example.com/v1" });
      expect(out).toContain('Unknown provider "ghost"');
      expect(out).toContain("real");
      expect(out).toContain("facode provider add ghost");
    });

    it("respects --scope project (updates the project layer only)", async () => {
      await addProvider({
        name: "scoped",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        scope: "project",
        cwd: project,
      });
      await updateProvider({
        name: "scoped",
        apiKey: "env:PROJ_VAR",
        scope: "project",
        cwd: project,
      });
      const raw = await projectCfg();
      expect(raw.providers.scoped.apiKeyEnv).toBe("PROJ_VAR");
      // The user layer must stay untouched.
      await expect(readFile(join(userDir, "config.json"), "utf8")).rejects.toThrow();
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
    it("errors on an unknown provider and suggests the nearest name", async () => {
      addProvider({
        name: "apinex",
        baseURL: "https://api.apinex.bond/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "free/muse-spark-1.3",
      });
      const result = useProvider(project, "apinexx");
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Unknown provider "apinexx"');
      expect(result.message).toContain('Did you mean "apinex"?');
      expect(result.message).toContain("Available:");
    });

    it("accepts a pasted trailing period", async () => {
      addProvider({
        name: "apinex",
        baseURL: "https://api.apinex.bond/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "free/muse-spark-1.3",
      });
      const result = useProvider(project, "apinex.", "user");
      expect(result.ok).toBe(true);
      expect(result.provider).toBe("apinex");
      expect(result.message).toContain('✔ Active provider set to "apinex"');
      expect(result.message).toContain('ignored the trailing "."');
      expect((await userCfg()).activeProvider).toBe("apinex");
    });

    it("matches provider names ignoring case", async () => {
      addProvider({
        name: "apinex",
        baseURL: "https://api.apinex.bond/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      const result = useProvider(project, "APINEX", "user");
      expect(result.ok).toBe(true);
      expect(result.provider).toBe("apinex");
      expect((await userCfg()).activeProvider).toBe("apinex");
    });

    it("persists activeProvider to the requested layer", async () => {
      addProvider({
        name: "pickme",
        baseURL: "https://u.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "m1",
      });
      const out = useProvider(project, "pickme", "user").message;
      expect(out).toContain('✔ Active provider set to "pickme"');
      expect(out).toContain("m1");
      const raw = await userCfg();
      expect(raw.activeProvider).toBe("pickme");

      const out2 = useProvider(project, "pickme", "project").message;
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
      const out = useProvider(project, "other", "user").message;
      expect(out).toContain('pins activeProvider="pinprov"');
    });

    it("warns when a pinned model belongs to a different provider", async () => {
      await mkdir(join(project, ".facode"), { recursive: true });
      await writeFile(
        join(project, ".facode", "config.json"),
        JSON.stringify({ model: "nvidia/nemotron-3-ultra-550b-a55b:free" }),
        "utf8"
      );
      addProvider({
        name: "apinex",
        baseURL: "https://api.apinex.bond/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "free/muse-spark-1.3",
      });
      const result = useProvider(project, "apinex", "user");
      expect(result.ok).toBe(true);
      expect(result.message).toContain("nvidia/nemotron-3-ultra-550b-a55b:free");
      expect(result.message).toContain("free/muse-spark-1.3");
      expect(result.message).toContain("facode model set free/muse-spark-1.3 --scope project");
    });

    it("fails loudly when the config cannot be written", async () => {
      addProvider({
        name: "writeprov",
        baseURL: "https://w.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      // The provider resolves from the user layer; a directory at the project
      // config path makes the project-scope write fail with EISDIR on every
      // platform without hiding the provider.
      await mkdir(join(project, ".facode", "config.json"), { recursive: true });
      const result = useProvider(project, "writeprov", "project");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Could not set the active provider");
      expect(result.message).toContain("NOT saved");
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

  describe("resolvePickAnswer", () => {
    const ordered = ["free-a:free", "free-b:free", "paid-a", "paid-b"];

    it("resolves 1-based numbers into list entries", () => {
      expect(resolvePickAnswer("1", ordered)).toBe("free-a:free");
      expect(resolvePickAnswer("4", ordered)).toBe("paid-b");
    });

    it("rejects out-of-range numbers and non-numeric junk", () => {
      expect(resolvePickAnswer("0", ordered)).toBeUndefined();
      expect(resolvePickAnswer("5", ordered)).toBeUndefined();
      expect(resolvePickAnswer("-1", ordered)).toBeUndefined();
      expect(resolvePickAnswer("abc", ordered)).toBeUndefined();
      expect(resolvePickAnswer("", ordered)).toBeUndefined();
      expect(resolvePickAnswer("   ", ordered)).toBeUndefined();
    });

    it("accepts exact ids from the list (with surrounding spaces)", () => {
      expect(resolvePickAnswer("paid-a", ordered)).toBe("paid-a");
      expect(resolvePickAnswer("  free-b:free  ", ordered)).toBe("free-b:free");
      // An id NOT in the list must not pass the picker (typo protection).
      expect(resolvePickAnswer("not-listed", ordered)).toBeUndefined();
    });
  });

  describe("listProviderModels", () => {
    it("groups free models first with counts", async () => {
      addProvider({
        name: "modelly",
        baseURL: "https://models.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: "paid-alpha" }, { id: "beta:free" }, { id: "alpha:free" }, { id: "paid-beta" }],
          }),
        })
      );
      const out = await listProviderModels(project, "modelly");
      expect(out).toContain("4 total, 2 free");
      // Free block comes before the other models, ids preserved.
      expect(out.indexOf("beta:free")).toBeLessThan(out.indexOf("Other models:"));
      expect(out.indexOf("Other models:")).toBeLessThan(out.indexOf("paid-alpha"));
      expect(out).toContain("facode model set --pick modelly");
      // The fetch went to the /models URL with the bearer key.
      const call = (fetch as any).mock.calls[0];
      expect(call[0]).toBe("https://models.example.com/v1/models");
      expect(call[1].headers.Authorization).toBe("Bearer sk-abcdefghijklmnop1234");
    });

    it("reports unknown providers, HTTP errors, and empty lists", async () => {
      expect(await listProviderModels(project, "nope")).toContain("Unknown provider");

      addProvider({ name: "err", baseURL: "https://e.example.com/v1", apiKey: "sk-abcdefghijklmnop1234" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "no key" })
      );
      expect(await listProviderModels(project, "err")).toContain("HTTP 401");

      addProvider({ name: "empty", baseURL: "https://m.example.com/v1", apiKey: "sk-abcdefghijklmnop1234" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) })
      );
      expect(await listProviderModels(project, "empty")).toContain("returned no models");
    });

    it("sends no auth header when the provider's key resolves to empty", async () => {
      // An env-referenced key whose variable is unset resolves to "" — the
      // /models call must then omit the Authorization header entirely.
      addProvider({
        name: "keyless",
        baseURL: "https://k.example.com/v1",
        apiKey: "env:FACODE_TEST_KEYLESS",
      });
      delete process.env.FACODE_TEST_KEYLESS;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "m" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      await listProviderModels(project, "keyless");
      expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
    });
  });

  describe("pickModel", () => {
    // vitest runs without a TTY, so the picker should refuse to prompt (the
    // actual interactive flow is exercised manually in a real terminal).
    it.runIf(!process.stdin.isTTY)("declines to prompt without a TTY (no fetch)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const out = await pickModel(project, undefined);
      expect(out).toContain("needs a terminal (TTY)");
      expect(out).toContain("facode provider models");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.runIf(!process.stdin.isTTY)("names an unknown provider before prompting", async () => {
      const out = await pickModel(project, "ghost");
      expect(out).toContain('Unknown provider "ghost"');
    });
  });

  describe("getModelChoices", () => {
    it("returns the named provider's models free-first when there is no TTY to prompt for", async () => {
      addProvider({
        name: "chooser",
        baseURL: "https://c.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "paid-a" }, { id: "x:free" }, { id: "y-free" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const choices = await getModelChoices(project, "chooser");
      expect(choices.ok).toBe(true);
      expect(choices.label).toBe("chooser");
      // Both free conventions (`:free` and `-free`) sort ahead of paid models.
      expect(choices.models).toEqual(["x:free", "y-free", "paid-a"]);
      expect(choices.freeCount).toBe(2);
      expect(fetchMock.mock.calls[0][0]).toBe("https://c.example.com/v1/models");
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        "Bearer sk-abcdefghijklmnop1234"
      );
    });

    it("falls back to the active/resolved endpoint when no provider is named", async () => {
      addProvider({
        name: "activep",
        baseURL: "https://a.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
      });
      useProvider(project, "activep", "user");
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "only-model" }] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const choices = await getModelChoices(project);
      expect(choices.ok).toBe(true);
      expect(choices.label).toBe("activep");
      expect(fetchMock.mock.calls[0][0]).toBe("https://a.example.com/v1/models");
    });

    it("reports unknown providers, HTTP failures, and empty listings as messages", async () => {
      const unknown = await getModelChoices(project, "ghost");
      expect(unknown.ok).toBe(false);
      expect(unknown.message).toContain('Unknown provider "ghost"');

      addProvider({ name: "errp", baseURL: "https://e.example.com/v1", apiKey: "sk-abcdefghijklmnop1234" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "no key" })
      );
      const failed = await getModelChoices(project, "errp");
      expect(failed.ok).toBe(false);
      expect(failed.message).toContain("HTTP 401");
      expect(failed.models).toEqual([]);

      addProvider({ name: "emptyp", baseURL: "https://m.example.com/v1", apiKey: "sk-abcdefghijklmnop1234" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) })
      );
      const empty = await getModelChoices(project, "emptyp");
      expect(empty.ok).toBe(false);
      expect(empty.message).toContain("returned no models");
    });
  });

  describe("providerChoices", () => {
    it("lists built-ins plus custom providers and marks the active one", () => {
      addProvider({
        name: "mine",
        baseURL: "https://m.example.com/v1",
        apiKey: "sk-abcdefghijklmnop1234",
        model: "mine-model",
      });
      useProvider(project, "mine", "user");

      const choices = providerChoices(project);
      const custom = choices.find((c) => c.name === "mine");
      expect(custom).toEqual({
        name: "mine",
        baseURL: "https://m.example.com/v1",
        model: "mine-model",
        builtin: false,
        active: true,
      });
      // Built-ins are switchable but flagged, and the default "openai" value is
      // NOT treated as a selected provider.
      const openai = choices.find((c) => c.name === "openai");
      expect(openai?.builtin).toBe(true);
      expect(openai?.active).toBe(false);
      expect(choices.find((c) => c.name === "deepseek")?.builtin).toBe(true);
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
