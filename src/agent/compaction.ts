import type { Message } from "@/agent/types";
import { createCompletion, getProviderOptions } from "@/agent/provider";

export interface CompactionOptions {
  cwd: string;
  /** How many recent messages to keep verbatim (default 6). */
  keep?: number;
  /** Max characters of transcript fed to the summarizer. */
  maxTranscriptChars?: number;
}

const SUMMARIZER_SYSTEM = [
  "You summarize a coding-agent conversation so it can continue with limited context.",
  "Be concise but preserve: the user's goal, key decisions, file paths, commands run,",
  "errors encountered and their fixes, and any unfinished next steps.",
  "Output only the summary — no preamble.",
].join(" ");

/** Produce a compacted message list: one system summary + the most recent messages. */
export async function compactMessages(
  messages: Message[],
  opts: CompactionOptions
): Promise<Message[]> {
  const keep = opts.keep ?? 6;
  if (messages.length <= keep) return messages;

  const toSummarize = messages.slice(0, messages.length - keep);
  const recent = messages.slice(messages.length - keep);
  const summary = await summarizeMessages(toSummarize, opts.cwd, opts.maxTranscriptChars);

  return [
    { role: "system", content: `[Context compacted] ${summary}` },
    ...recent,
  ];
}

/** Summarize a list of messages with the configured LLM (no tools). */
export async function summarizeMessages(
  messages: Message[],
  cwd: string,
  maxTranscriptChars?: number
): Promise<string> {
  const transcriptRaw = messages
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : "";
      const toolInfo = m.tool_calls?.length
        ? ` [tool_calls: ${m.tool_calls.map((c) => c.function.name).join(", ")}]`
        : "";
      return `${m.role}: ${text}${toolInfo}`;
    })
    .join("\n");

  const transcript = maxTranscriptChars ? transcriptRaw.slice(0, maxTranscriptChars) : transcriptRaw;

  const { content } = await createCompletion(
    [
      { role: "system", content: SUMMARIZER_SYSTEM },
      { role: "user", content: transcript || "(empty conversation)" },
    ],
    getProviderOptions(cwd),
    []
  );
  return content?.trim() || "(no summary produced)";
}
