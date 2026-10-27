import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { executeSlash, findSlashCommand, getSlashCommands } from "@/cli";
import type { CommandContext } from "@/cli";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Slash Commands", () => {
  const dummyCtx = {
    cwd: process.cwd(),
    messages: [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there!" },
    ],
    setMessages: vi.fn(),
    setStatus: vi.fn(),
    setPermissionMode: vi.fn(),
    setProvider: vi.fn(),
    permissionMode: "default" as const,
    compact: vi.fn().mockResolvedValue(undefined),
    exit: vi.fn(),
  } as unknown as CommandContext;

  it("should list all commands on /help", async () => {
    const res = await executeSlash("/help", dummyCtx);
    expect(res).toContain("/help");
    expect(res).toContain("/doctor");
    expect(res).toContain("/cost");
    expect(res).toContain("/rea");
  });

  it("should show current model on /model", async () => {
    const res = await executeSlash("/model", dummyCtx);
    expect(res).toContain("Current model:");
    expect(res).toContain("Active provider:");
  });

  it("should calculate conversation stats on /cost and /tokens", async () => {
    const resCost = await executeSlash("/cost", dummyCtx);
    expect(resCost).toContain("Total messages:");
    expect(resCost).toContain("User prompts:");

    const resTokens = await executeSlash("/tokens", dummyCtx);
    expect(resTokens).toBe(resCost);
  });

  it("should handle /permissions command", async () => {
    const resInfo = await executeSlash("/permissions", dummyCtx);
    expect(resInfo).toContain("Current permission mode:");

    const resSet = await executeSlash("/permissions plan", dummyCtx);
    expect(resSet).toContain('Permission mode set to "plan"');
    expect(dummyCtx.setPermissionMode).toHaveBeenCalledWith("plan");
  });

  it("should clear messages on /clear", async () => {
    const res = await executeSlash("/clear", dummyCtx);
    expect(res).toContain("cleared");
    expect(dummyCtx.setMessages).toHaveBeenCalledWith([]);
  });

  it("should support /rea commands", async () => {
    const res = await executeSlash("/rea", dummyCtx);
    expect(res).toContain("REA");
  });

  it("should return helpful error for unknown commands", async () => {
    const res = await executeSlash("/unknowncmd", dummyCtx);
    expect(res).toContain("Unknown command: /unknowncmd");
  });
});

describe("Slash provider/model management", () => {
  // Isolated user + project layers so nothing touches the real ~/.facode or
  // the repo's .facode config.
  let userDir = "";
  let project = "";
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
  afterEach(async () => {
    if (oldUserDir === undefined) delete process.env.FACODE_USER_DIR;
    else process.env.FACODE_USER_DIR = oldUserDir;
    if (project) await rm(project, { recursive: true, force: true });
  });

  const makeCtx = async (): Promise<CommandContext> => {
    project = await mkdtemp(join(tmpdir(), "facode-proj-"));
    return {
      cwd: project,
      messages: [],
      setMessages: vi.fn(),
      setStatus: vi.fn(),
      setPermissionMode: vi.fn(),
      setProvider: vi.fn(),
      permissionMode: "default" as const,
      compact: vi.fn().mockResolvedValue(undefined),
      exit: vi.fn(),
    } as unknown as CommandContext;
  };

  const userCfg = async () => JSON.parse(await readFile(join(userDir, "config.json"), "utf8"));

  it("/provider add registers a provider in the user layer (key masked)", async () => {
    const ctx = await makeCtx();
    const res = await executeSlash(
      "/provider add slashprov https://s.example.com/v1 sk-abcdefghijklmnop1234 my-slash-model",
      ctx
    );
    expect(res).toContain('✔ Provider "slashprov" added');
    expect(res).not.toContain("sk-abcdefghijklmnop1234");
    const raw = await userCfg();
    expect(raw.providers.slashprov.model).toBe("my-slash-model");
  });

  it("/provider add env:VAR stores an apiKeyEnv reference", async () => {
    const ctx = await makeCtx();
    await executeSlash("/provider add envprov https://s.example.com/v1 env:MY_VAR", ctx);
    const raw = await userCfg();
    expect(raw.providers.envprov.apiKeyEnv).toBe("MY_VAR");
  });

  it("/provider use switches the active provider", async () => {
    const ctx = await makeCtx();
    await executeSlash("/provider add uprov https://s.example.com/v1 sk-abcdefghijklmnop1234", ctx);
    const res = await executeSlash("/provider use uprov", ctx);
    expect(res).toContain('✔ Active provider set to "uprov"');
    expect(ctx.setProvider).toHaveBeenCalledWith("uprov");
    const raw = await userCfg();
    expect(raw.activeProvider).toBe("uprov");
  });

  it("/provider <name> still switches (back-compat) and /provider list shows it", async () => {
    const ctx = await makeCtx();
    await executeSlash("/provider add bprov https://s.example.com/v1 sk-abcdefghijklmnop1234", ctx);
    const res = await executeSlash("/provider bprov", ctx);
    expect(res).toContain('✔ Active provider set to "bprov"');
    expect(ctx.setProvider).toHaveBeenCalledWith("bprov");

    const list = await executeSlash("/provider list", ctx);
    expect(list).toContain("bprov");
  });

  it("/provider remove deletes the provider", async () => {
    const ctx = await makeCtx();
    await executeSlash("/provider add doomed https://s.example.com/v1 sk-abcdefghijklmnop1234", ctx);
    const res = await executeSlash("/provider remove doomed", ctx);
    expect(res).toContain('✔ Provider "doomed" removed');
    const raw = await userCfg();
    expect(raw.providers.doomed).toBeUndefined();
  });

  it("/provider set updates baseURL + key + model (new key masked)", async () => {
    const ctx = await makeCtx();
    await executeSlash(
      "/provider add setprov https://old.example.com/v1 sk-abcdefghijklmnop1234 old-model",
      ctx
    );
    const res = await executeSlash(
      "/provider set setprov https://new.example.com/v1 sk-newnewnewnewnew456 new-model",
      ctx
    );
    expect(res).toContain('✔ Provider "setprov" updated in');
    expect(res).not.toContain("sk-newnewnewnewnew456");
    const raw = await userCfg();
    expect(raw.providers.setprov.baseURL).toBe("https://new.example.com/v1");
    expect(raw.providers.setprov.apiKey).toBe("sk-newnewnewnewnew456");
    expect(raw.providers.setprov.model).toBe("new-model");
    // The old key is fully gone from THIS provider.
    expect(JSON.stringify(raw.providers.setprov)).not.toContain("sk-abcdefghijklmnop1234");
  });

  it("/provider set keeps the stored key when omitted (partial update)", async () => {
    const ctx = await makeCtx();
    await executeSlash("/provider add keepprov https://old.example.com/v1 sk-abcdefghijklmnop1234", ctx);
    const res = await executeSlash("/provider set keepprov https://moved.example.com/v1", ctx);
    expect(res).toContain("updated in");
    const raw = await userCfg();
    expect(raw.providers.keepprov.baseURL).toBe("https://moved.example.com/v1");
    expect(raw.providers.keepprov.apiKey).toBe("sk-abcdefghijklmnop1234");
  });

  it("/provider set refuses built-ins and prints usage on bad input", async () => {
    const ctx = await makeCtx();
    expect(
      await executeSlash("/provider set openai https://evil.example.com/v1", ctx)
    ).toContain("built-in and cannot be modified");
    expect(await executeSlash("/provider set ghost", ctx)).toContain("Usage: /provider set");
    expect(await executeSlash("/provider set", ctx)).toContain("Usage: /provider set");
  });

  it("/model <name> persists the model", async () => {
    const ctx = await makeCtx();
    const res = await executeSlash("/model slash-model", ctx);
    expect(res).toContain('✔ Model set to "slash-model"');
    const raw = await userCfg();
    expect(raw.model).toBe("slash-model");
  });

  it("/provider models lists the endpoint's models (free first)", async () => {
    const ctx = await makeCtx();
    await executeSlash("/provider add mprov https://s.example.com/v1 sk-abcdefghijklmnop1234", ctx);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "paid-1" }, { id: "nice:free" }] }),
      })
    );
    const res = await executeSlash("/provider models mprov", ctx);
    expect(res).toContain("2 total, 1 free");
    expect(res).toContain("nice:free");
    vi.unstubAllGlobals();
  });

  it("/model pick lists models for the active provider without prompting", async () => {
    const ctx = await makeCtx();
    await executeSlash("/provider add mpick https://s.example.com/v1 sk-abcdefghijklmnop1234", ctx);
    await executeSlash("/provider use mpick", ctx);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "a:free" }, { id: "b" }] }),
      })
    );
    // vitest has no TTY, and /model pick must NOT prompt inside the TUI —
    // it renders the list instead.
    const res = await executeSlash("/model pick", ctx);
    expect(res).toContain('Models for "mpick"');
    expect(res).toContain("a:free");
    expect(res).toContain("b");
    vi.unstubAllGlobals();
  });

  it("/model pick still works with a bare model name argument (regression)", async () => {
    const ctx = await makeCtx();
    const res = await executeSlash("/model real-model", ctx);
    expect(res).toContain('✔ Model set to "real-model"');
  });
});
