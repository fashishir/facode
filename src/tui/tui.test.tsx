import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { render, type InkInstance } from "./ink-test-utils";
import { ChatTranscript, LiveTurn, type TranscriptItem } from "./chat-history";
import { InputBox } from "./input-box";

// Regression tests for the TUI rendering restructure: the completed transcript
// renders through Ink's <Static> (each item flushed exactly once), the input
// box owns its value state, and deactivating it stops key consumption.

const tick = () => new Promise<void>((r) => setTimeout(r, 60));

// Strip ANSI/VT escape sequences (colors, sync markers ?2026h, cursor ?25l...)
// so assertions match visible text only.
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");

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
    await tick();
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
    await tick();
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
    await tick();
    stdin.write("x\r");
    await tick();
    expect(stripAnsi(getOut())).not.toContain("x");
    expect(submitted).toEqual([]);
    instance.unmount();
  });

  it("supports backspace and up-arrow history", async () => {
    const submitted: string[] = [];
    const { stdout, stdin } = makeStreams();
    const instance = render(
      <InputBox onSubmit={(v) => submitted.push(v)} history={["previous prompt"]} />,
      { stdout, stdin }
    );
    instances.push(instance);
    await tick();
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
