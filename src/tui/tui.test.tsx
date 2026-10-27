import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, type InkInstance } from "./ink-test-utils";
import { ChatTranscript, LiveTurn, type TranscriptItem } from "./chat-history";
import { InputBox } from "./input-box";
import { SelectList } from "./select-list";
import { ModelPicker } from "./model-picker";
import { ProviderForm, validateProviderForm, type ProviderFormValues } from "./provider-form";
import { TuiApp } from "./app";

// Regression tests for the TUI rendering restructure: the completed transcript
// renders through Ink's <Static> (each item flushed exactly once), the input
// box owns its value state, and deactivating it stops key consumption.

const tick = () => new Promise<void>((r) => setTimeout(r, 60));

// Ink renders, effects, and async config writes settle on their own schedule.
// A fixed sleep passes in isolation but flakes when the whole suite runs in
// parallel, so overlay tests poll for the state they need instead.
const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  what = "condition",
  timeoutMs = 10000
): Promise<void> => {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// A frame reaching the stream does not mean the new tree's useInput hooks have
// subscribed yet. Yield through macrotasks so React can flush passive effects
// before the test starts typing into a freshly mounted overlay.
const flushEffects = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setImmediate(r));
  await tick();
};

// The highlight of the newest frame (SelectList renders "❯ <label>  <detail>").
const highlighted = (streams: ReturnType<typeof makeStreams>): string => {
  const raw = streams.getOut();
  const at = raw.lastIndexOf("❯");
  if (at < 0) return "";
  return stripAnsi(raw.slice(at, at + 240)).split("\n")[0]?.trim() ?? "";
};

// Step the list until `done()` is true, re-sending if a press was delivered
// before the overlay subscribed. Never overshoots: it checks before each press.
const pressUntil = async (
  streams: ReturnType<typeof makeStreams>,
  key: string,
  done: () => boolean,
  what: string,
  max = 25
): Promise<void> => {
  for (let i = 0; i < max; i++) {
    if (done()) return;
    streams.stdin.write(key);
    await tick();
  }
  if (done()) return;
  throw new Error(`pressUntil timed out: ${what} (highlight: ${highlighted(streams)})`);
};

// Strip ANSI/VT escape sequences (colors, sync markers ?2026h, cursor ?25l...)
// so assertions match visible text only.
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");

/**
 * Ink paints its first frame asynchronously. A fixed sleep passes locally but
 * flakes on loaded CI runners, where the first paint can take hundreds of ms.
 * Wait for visible text, then let the tree's useInput hooks subscribe.
 */
const waitForFrame = async (
  getOut: () => string,
  what = "first Ink frame",
  timeoutMs = 10000
): Promise<string> => {
  let out = "";
  await waitFor(() => {
    out = getOut();
    return stripAnsi(out).trim().length > 0;
  }, what, timeoutMs);
  await flushEffects();
  return out;
};

const instances: InkInstance[] = [];

function makeStreams() {
  const stdout = new PassThrough();
  (stdout as any).isTTY = true;
  (stdout as any).columns = 100;
  (stdout as any).rows = 40;
  let out = "";
  stdout.on("data", (c: Buffer | string) => {
    out += c.toString();
  });
  const stdin = new PassThrough();
  (stdin as any).isTTY = true;
  (stdin as any).setRawMode = () => {};
  return { stdout, stdin, getOut: () => out };
}

const baseItems: TranscriptItem[] = [
  {
    kind: "banner",
    banner: { model: "deepseek-v4.1-flash:free", provider: "deepseek", cwd: process.cwd() },
  },
  { kind: "message", message: { role: "user", content: "hello world" } },
  { kind: "message", message: { role: "assistant", content: "Hi there" } },
  { kind: "message", message: { role: "tool", name: "Read", content: "file body" } },
];

describe("ChatTranscript (Static)", () => {
  afterEach(() => {
    while (instances.length) instances.pop()!.unmount();
  });

  it("flushes banner and all completed messages once", async () => {
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(<ChatTranscript items={baseItems} />, { stdout, stdin });
    instances.push(instance);
    await tick();
    const out = getOut();
    // Strip ANSI codes for stable assertions
    const plain = stripAnsi(out);
    expect(plain).toContain("FA CODE");
    expect(plain).toContain("deepseek-v4.1-flash:free");
    expect(plain).toContain("hello world");
    expect(plain).toContain("Hi there");
    expect(plain).toContain("Read");
    instance.unmount();
  });

  it("renders new items without re-rendering flushed ones", async () => {
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(<ChatTranscript items={baseItems.slice(0, 2)} />, { stdout, stdin });
    instances.push(instance);
    await tick();
    // Rerender with an appended item — appended transcript only, no remount.
    instance.rerender(
      <ChatTranscript
        items={[...baseItems.slice(0, 2), baseItems[2]]}
      />
    );
    await tick();
    const plain = stripAnsi(getOut());
    expect(plain).toContain("hello world");
    expect(plain).toContain("Hi there");
    instance.unmount();
  });
});

describe("LiveTurn", () => {
  afterEach(() => {
    while (instances.length) instances.pop()!.unmount();
  });

  it("renders streaming content, reasoning, and the active tool spinner", async () => {
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <LiveTurn
        streamingContent="partial answer"
        streamingReasoning="thinking hard"
        activeTool="Bash"
      />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "LiveTurn to render");
    const plain = stripAnsi(getOut());
    expect(plain).toContain("partial answer");
    expect(plain).toContain("thinking hard");
    expect(plain).toContain("Running Bash...");
    instance.unmount();
  });

  it("renders nothing when idle", async () => {
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(<LiveTurn />, { stdout, stdin });
    instances.push(instance);
    await tick();
    expect(stripAnsi(getOut()).trim()).toBe("");
    instance.unmount();
  });
});

describe("InputBox", () => {
  afterEach(() => {
    while (instances.length) instances.pop()!.unmount();
  });

  it("accumulates keystrokes and submits on Enter", async () => {
    const submitted: string[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(<InputBox onSubmit={(v) => submitted.push(v)} />, { stdout, stdin });
    instances.push(instance);
    await waitForFrame(getOut, "InputBox to render");
    stdin.write("hi");
    await tick();
    expect(stripAnsi(getOut())).toContain("hi");
    stdin.write("\r");
    await tick();
    expect(submitted).toEqual(["hi"]);
    instance.unmount();
  });

  it("does not consume keys when inactive", async () => {
    const submitted: string[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <InputBox onSubmit={(v) => submitted.push(v)} isActive={false} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "InputBox to render");
    stdin.write("x\r");
    await tick();
    expect(stripAnsi(getOut())).not.toContain("x");
    expect(submitted).toEqual([]);
    instance.unmount();
  });

  it("supports backspace and up-arrow history", async () => {
    const submitted: string[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <InputBox onSubmit={(v) => submitted.push(v)} history={["previous prompt"]} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "InputBox to render");
    stdin.write("abc");
    await tick();
    stdin.write("\u007F"); // backspace removes "c"
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted[0]).toBe("ab");
    instance.unmount();
  });
});

// The in-chat pickers/forms: Ink owns stdin in the TUI, so these are how the
// CLI's readline choosers (`model set --pick`, `provider add` prompts) are
// offered from the chat box instead.
describe("SelectList", () => {
  afterEach(() => {
    while (instances.length) instances.pop()!.unmount();
  });

  it("navigates with the arrow keys and selects with Enter", async () => {
    const selected: number[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <SelectList
        title="Pick one"
        items={[{ label: "alpha" }, { label: "beta" }, { label: "gamma" }]}
        onSelect={(i) => selected.push(i)}
      />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "SelectList to render");
    expect(stripAnsi(getOut())).toContain("Pick one");
    expect(stripAnsi(getOut())).toContain("alpha");

    stdin.write("\u001B[B"); // down arrow
    await tick();
    stdin.write("\r");
    await tick();
    expect(selected).toEqual([1]);
    instance.unmount();
  });

  it("cancels on Escape and windows long lists", async () => {
    let cancelled = 0;
    const items = Array.from({ length: 40 }, (_, i) => ({ label: `model-${String(i).padStart(2, "0")}` }));
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <SelectList title="Many" items={items} onCancel={() => cancelled++} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "SelectList to render");
    const plain = stripAnsi(getOut());
    // Only a window of rows is rendered, with a count of what is below.
    expect(plain).toContain("model-00");
    expect(plain).not.toContain("model-39");
    expect(plain).toContain("below");

    stdin.write("\u001B"); // escape
    await tick();
    expect(cancelled).toBe(1);
    instance.unmount();
  });
});

describe("ModelPicker", () => {
  const oldUserDir = process.env.FACODE_USER_DIR;
  let userDir = "";
  let project = "";

  beforeEach(async () => {
    // Isolated layers: the picker resolves providers from config, and neither
    // the machine's ~/.facode nor the repo's .facode may influence it.
    userDir = await mkdtemp(join(tmpdir(), "facode-tui-user-"));
    process.env.FACODE_USER_DIR = userDir;
    project = await mkdtemp(join(tmpdir(), "facode-tui-proj-"));
    await mkdir(join(project, ".facode"), { recursive: true });
    await writeFile(
      join(project, ".facode", "config.json"),
      JSON.stringify({
        providers: {
          mp: { baseURL: "https://mp.example.com/v1", apiKey: "sk-abcdefghijklmnop1234", model: "" },
        },
      }),
      "utf8"
    );
  });

  afterEach(async () => {
    while (instances.length) instances.pop()!.unmount();
    vi.unstubAllGlobals();
    if (oldUserDir === undefined) delete process.env.FACODE_USER_DIR;
    else process.env.FACODE_USER_DIR = oldUserDir;
    if (userDir) await rm(userDir, { recursive: true, force: true });
    if (project) await rm(project, { recursive: true, force: true });
  });

  it("lists the endpoint's models free-first and selects with Enter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "paid-model" }, { id: "free-model:free" }] }),
      })
    );
    const picked: string[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <ModelPicker cwd={project} provider="mp" onSelect={(m) => picked.push(m)} onCancel={() => {}} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitFor(
      () => stripAnsi(getOut()).includes("free-model:free"),
      "models to load"
    );
    await flushEffects();
    const plain = stripAnsi(getOut());
    expect(plain).toContain("free-model:free");
    expect(plain).toContain("(free)");
    expect(plain.indexOf("free-model:free")).toBeLessThan(plain.indexOf("paid-model"));

    stdin.write("\r");
    await tick();
    expect(picked).toEqual(["free-model:free"]);
    instance.unmount();
  });

  it("highlights the currently configured model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "first" }, { id: "current" }] }),
      })
    );
    const picked: string[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <ModelPicker
        cwd={project}
        provider="mp"
        currentModel="current"
        onSelect={(m) => picked.push(m)}
        onCancel={() => {}}
      />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitFor(() => stripAnsi(getOut()).includes("current"), "models to load");
    await flushEffects();
    stdin.write("\r");
    await tick();
    expect(picked).toEqual(["current"]);
    instance.unmount();
  });

  it("reports endpoint failures inline and closes on Enter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "bad key" })
    );
    const cancels: (string | undefined)[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <ModelPicker cwd={project} provider="mp" onSelect={() => {}} onCancel={(m) => cancels.push(m)} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitFor(() => stripAnsi(getOut()).includes("HTTP 401"), "endpoint error to render");
    await flushEffects();
    expect(stripAnsi(getOut())).toContain("HTTP 401");

    stdin.write("\r");
    await tick();
    expect(cancels[0]).toContain("HTTP 401");
    instance.unmount();
  });
});

describe("ProviderForm", () => {
  afterEach(() => {
    while (instances.length) instances.pop()!.unmount();
  });

  it("walks the fields with Tab and submits the typed values", async () => {
    const submitted: ProviderFormValues[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <ProviderForm onCancel={() => {}} onSubmit={(v) => submitted.push(v)} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "provider form to render");
    expect(stripAnsi(getOut())).toContain("Add a custom provider");

    stdin.write("myproxy");
    await tick();
    stdin.write("\t");
    await tick();
    stdin.write("https://api.example.com/v1");
    await tick();
    stdin.write("\t");
    await tick();
    stdin.write("sk-testkey1234");
    await tick();
    stdin.write("\r"); // apiKey → model field
    await tick();
    stdin.write("my-model");
    await tick();
    stdin.write("\r"); // last field → submit
    await tick();

    expect(submitted).toEqual([
      {
        name: "myproxy",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-testkey1234",
        model: "my-model",
      },
    ]);
    instance.unmount();
  });

  it("prefills the name (focus starts on the base URL) and accepts env: keys", async () => {
    const submitted: ProviderFormValues[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <ProviderForm prefillName="myproxy" onCancel={() => {}} onSubmit={(v) => submitted.push(v)} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "provider form to render");

    stdin.write("https://api.example.com/v1");
    await tick();
    stdin.write("\t");
    await tick();
    stdin.write("env:MY_API_KEY");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("\r");
    await tick();

    expect(submitted).toEqual([
      {
        name: "myproxy",
        baseURL: "https://api.example.com/v1",
        apiKey: "env:MY_API_KEY",
        model: "",
      },
    ]);
    instance.unmount();
  });

  it("blocks submission with invalid input and reports which field failed", async () => {
    const submitted: ProviderFormValues[] = [];
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <ProviderForm onCancel={() => {}} onSubmit={(v) => submitted.push(v)} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "provider form to render");

    stdin.write("1bad name");
    await tick();
    stdin.write("\t");
    await tick();
    stdin.write("not-a-url");
    await tick();
    stdin.write("\r"); // → apiKey
    await tick();
    stdin.write("\r"); // → model
    await tick();
    stdin.write("\r"); // submit attempt
    await tick();

    expect(submitted).toEqual([]);
    expect(stripAnsi(getOut())).toContain("Invalid provider name");
    instance.unmount();
  });

  it("cancels on Escape without submitting", async () => {
    const submitted: ProviderFormValues[] = [];
    let cancelled = 0;
    const { stdout, stdin, getOut } = makeStreams();
    const instance = render(
      <ProviderForm
        onCancel={() => cancelled++}
        onSubmit={(v) => submitted.push(v)}
      />,
      { stdout, stdin }
    );
    instances.push(instance);
    await waitForFrame(getOut, "provider form to render");
    stdin.write("http");
    await tick();
    stdin.write("\u001B");
    await tick();
    expect(cancelled).toBe(1);
    expect(submitted).toEqual([]);
    instance.unmount();
  });

  it("validateProviderForm reuses the shared name/URL rules", () => {
    const base: ProviderFormValues = {
      name: "good",
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-abcdefghijklmnop1234",
      model: "",
    };
    expect(validateProviderForm(base)).toBeNull();
    expect(validateProviderForm({ ...base, name: "1bad name" })?.field).toBe("name");
    expect(validateProviderForm({ ...base, baseURL: "not-a-url" })?.field).toBe("baseURL");
    expect(validateProviderForm({ ...base, baseURL: "ftp://x.example.com" })?.message).toContain(
      "must be http(s)"
    );
    expect(validateProviderForm({ ...base, apiKey: "" })?.field).toBe("apiKey");
    expect(validateProviderForm({ ...base, apiKey: "env:" })?.message).toContain(
      "variable name"
    );
    expect(validateProviderForm({ ...base, apiKey: "env:MY_API_KEY" })).toBeNull();
  });
});

// End-to-end through the real chat box: type the slash command, the overlay
// opens over the input, and choosing a row persists through the normal command
// path — the behavior a user actually triggers.
describe("TuiApp provider/model overlays", () => {
  const oldUserDir = process.env.FACODE_USER_DIR;
  let userDir = "";
  let project = "";

  beforeEach(async () => {
    userDir = await mkdtemp(join(tmpdir(), "facode-app-user-"));
    process.env.FACODE_USER_DIR = userDir;
    project = await mkdtemp(join(tmpdir(), "facode-app-proj-"));
    await mkdir(join(project, ".facode"), { recursive: true });
    await writeFile(
      join(project, ".facode", "config.json"),
      JSON.stringify({
        providers: {
          alpha: { baseURL: "https://alpha.example.com/v1", apiKey: "sk-abcdefghijklmnop1234", model: "alpha-model" },
          beta: { baseURL: "https://beta.example.com/v1", apiKey: "sk-abcdefghijklmnop1234", model: "beta-model" },
        },
      }),
      "utf8"
    );
  });

  afterEach(async () => {
    while (instances.length) instances.pop()!.unmount();
    vi.unstubAllGlobals();
    if (oldUserDir === undefined) delete process.env.FACODE_USER_DIR;
    else process.env.FACODE_USER_DIR = oldUserDir;
    if (userDir) await rm(userDir, { recursive: true, force: true });
    if (project) await rm(project, { recursive: true, force: true });
  });

  const renderApp = (streams: ReturnType<typeof makeStreams>) =>
    render(
      <TuiApp
        cwd={project}
        sessionId="tui-overlay-session"
        history={[]}
        tools={[]}
        mcp={{ listMcpTools: () => [] }}
        getProviderOptions={() => ({})}
      />,
      { stdout: streams.stdout, stdin: streams.stdin }
    );

  const readJson = async (file: string) => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return {};
    }
  };

  // Wait for the app's first painted frame (the chat box) and for its useInput
  // hooks to subscribe before typing. On a loaded CI runner the first paint can
  // arrive well after render() returns, and keys written before that are lost.
  const waitForInput = async (streams: ReturnType<typeof makeStreams>) => {
    await waitFor(
      () => stripAnsi(streams.getOut()).includes("FA Code... (/ for commands"),
      "chat input to render"
    );
    await flushEffects();
  };

  // Type a slash command and wait until the input box echoes it, proving the
  // component is subscribed to stdin before Enter is sent.
  const typeCommand = async (streams: ReturnType<typeof makeStreams>, command: string) => {
    streams.stdin.write(command);
    await waitFor(
      () => stripAnsi(streams.getOut()).includes(command),
      `"${command}" to be typed into the input box`
    );
  };

  it("`/provider use` opens the picker and Enter switches the active provider", async () => {
    const streams = makeStreams();
    const instance = renderApp(streams);
    instances.push(instance);
    await waitForInput(streams);

    await typeCommand(streams, "/provider use");
    streams.stdin.write("\r");
    await waitFor(
      () => stripAnsi(streams.getOut()).includes("Select a provider"),
      "provider picker to open"
    );
    const opened = stripAnsi(streams.getOut());
    expect(opened).toContain("Select a provider");
    // Built-ins first, then the custom providers from config.
    expect(opened).toContain("alpha");
    expect(opened).toContain("https://alpha.example.com/v1");
    await flushEffects();

    // Walk down to the custom `alpha` row and pick it.
    await pressUntil(
      streams,
      "\u001B[B",
      () => highlighted(streams).startsWith("❯ alpha"),
      "alpha to be highlighted"
    );
    streams.stdin.write("\r");

    await waitFor(
      async () => (await readJson(join(userDir, "config.json"))).activeProvider === "alpha",
      "active provider to be persisted"
    );
    const cfg: any = await readJson(join(userDir, "config.json"));
    expect(cfg.activeProvider).toBe("alpha");
    // The switch is reported in the transcript, through the normal command path.
    await waitFor(
      () => stripAnsi(streams.getOut()).includes('Active provider set to "alpha"'),
      "switch confirmation in the transcript"
    );
    instance.unmount();
  });

  it("`/provider add` with no fields opens the guided form and writes the provider", async () => {
    const streams = makeStreams();
    const instance = renderApp(streams);
    instances.push(instance);
    await waitForInput(streams);

    await typeCommand(streams, "/provider add");
    streams.stdin.write("\r");
    await waitFor(
      () => stripAnsi(streams.getOut()).includes("Add a custom provider"),
      "provider form to open"
    );
    expect(stripAnsi(streams.getOut())).toContain("Add a custom provider");
    await flushEffects();

    // Fill the form: name → URL → key → (model) → submit.
    streams.stdin.write("fromtui");
    await tick();
    streams.stdin.write("\t");
    await tick();
    streams.stdin.write("https://tui.example.com/v1");
    await tick();
    streams.stdin.write("\t");
    await tick();
    streams.stdin.write("sk-tui-key-1234");
    await tick();
    streams.stdin.write("\r");
    await tick();
    streams.stdin.write("\r");

    await waitFor(
      async () => Boolean((await readJson(join(userDir, "config.json"))).providers?.fromtui),
      "provider to be written to user config"
    );
    const cfg: any = await readJson(join(userDir, "config.json"));
    expect(cfg.providers?.fromtui).toEqual({
      baseURL: "https://tui.example.com/v1",
      apiKey: "sk-tui-key-1234",
      model: "",
    });
    await waitFor(
      () => stripAnsi(streams.getOut()).includes('Provider "fromtui" added'),
      "add confirmation in the transcript"
    );
    const out = stripAnsi(streams.getOut());
    expect(out).toContain('Provider "fromtui" added');
    // The transcript echo masks the key (the form's own field is on screen while
    // being typed, exactly like anything typed into the chat box).
    expect(out).toContain("sk-tui-k...1234");
    expect(out).toContain("/provider add fromtui https://tui.example.com/v1 sk-tui-k...1234");
    instance.unmount();
  });

  it("`/model pick` opens the model chooser for the active provider and sets the model", async () => {
    // Pin the active provider so the picker targets its endpoint.
    await writeFile(
      join(userDir, "config.json"),
      JSON.stringify({ activeProvider: "alpha" }),
      "utf8"
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "alpha-model" }, { id: "alpha-free:free" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const streams = makeStreams();
    const instance = renderApp(streams);
    instances.push(instance);
    await waitForInput(streams);

    await typeCommand(streams, "/model pick");
    streams.stdin.write("\r");
    await waitFor(
      () => stripAnsi(streams.getOut()).includes("Select a model"),
      "model picker to open"
    );
    const opened = stripAnsi(streams.getOut());
    expect(opened).toContain("Select a model");
    expect(opened).toContain("alpha-free:free");
    await waitFor(() => fetchMock.mock.calls.length > 0, "models request");
    expect(fetchMock.mock.calls[0][0]).toBe("https://alpha.example.com/v1/models");
    await flushEffects();

    // The current model is highlighted on open (it is the second row, since
    // free ids sort first) — up to the free model, then select it.
    await pressUntil(
      streams,
      "\u001B[A",
      () => highlighted(streams).startsWith("❯ alpha-free:free"),
      "free model to be highlighted"
    );
    streams.stdin.write("\r");
    await waitFor(
      async () => (await readJson(join(userDir, "config.json"))).model === "alpha-free:free",
      "selected model to be persisted"
    );
    const cfg: any = await readJson(join(userDir, "config.json"));
    expect(cfg.model).toBe("alpha-free:free");
    instance.unmount();
  });
});
