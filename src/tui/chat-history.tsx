import React from "react";
import { Box, Static, Text } from "ink";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Message, ToolCall } from "@/agent/types";

/**
 * Transcripts render through Ink's <Static>: each item is rendered exactly once
 * when it appears, then flushed into the terminal's native scrollback and never
 * re-rendered. Only the live turn (streaming text, spinner) and the input box
 * stay in Ink's dynamic buffer. This keeps every frame small, which is what
 * fixes the garbled/flickering TUI on Windows terminals once history grows.
 */
export type TranscriptItem =
  | { kind: "banner"; banner: BannerData }
  | { kind: "message"; message: Message };

export interface BannerData {
  model: string;
  provider?: string;
  cwd: string;
  version?: string;
}

export interface ChatTranscriptProps {
  items: TranscriptItem[];
}

export function ChatTranscript({ items }: ChatTranscriptProps) {
  return (
    <Static items={items}>
      {(item, index) =>
        item.kind === "banner" ? (
          <BannerStatic key={`banner-${index}`} banner={item.banner} />
        ) : (
          <Box key={`msg-${index}`}>{renderMessage(item.message, index)}</Box>
        )
      }
    </Static>
  );
}

/* ------------------------------------------------------------------ */
/* Static banner: flushed once at startup, then scrolls away with the  */
/* transcript (Claude Code style). Live REA status lives in the        */
/* dynamic StatusLine instead, so it can still update.                 */
/* ------------------------------------------------------------------ */

function BannerStatic({ banner }: { banner: BannerData }) {
  let gitBranch = "";
  try {
    gitBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: banner.cwd,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}

  const dirName = basename(banner.cwd) || banner.cwd;
  const isLegacyConhost =
    process.platform === "win32" &&
    !process.env.WT_SESSION &&
    !process.env.TERM_PROGRAM &&
    !process.env.ConEmuANSI;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={0}
      marginBottom={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan.bold">FA CODE </Text>
          <Text color="gray.dim">v{banner.version ?? "0.4.2"} • Claude Code CLI with REA Engine</Text>
        </Box>
        {gitBranch && (
          <Box>
            <Text color="gray">git:(</Text>
            <Text color="yellow.bold">{gitBranch}</Text>
            <Text color="gray">)</Text>
          </Box>
        )}
      </Box>

      <Box marginTop={0}>
        <Text color="gray">provider: </Text>
        <Text color="cyan.bold">{banner.provider ?? "openai"}</Text>
        <Text color="gray.dim"> │ model: </Text>
        <Text color="green.bold">{banner.model}</Text>
        <Text color="gray.dim"> │ cwd: </Text>
        <Text color="white">{dirName}</Text>
      </Box>

      <Box marginTop={0}>
        <Text color="gray.dim">
          Type prompt or <Text color="yellow.bold">/help</Text> for commands. <Text color="cyan">^C</Text> to interrupt.
        </Text>
      </Box>

      {isLegacyConhost && (
        <Box marginTop={0}>
          <Text color="yellow.dim">
            Tip: for smoothest TUI rendering, run facode in Windows Terminal (this console is legacy conhost).
          </Text>
        </Box>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* Live turn: streaming reasoning/text + active tool spinner. Rendered */
/* in the dynamic buffer while the current turn is in flight; content  */
/* moves into the Static transcript when the turn ends.                */
/* ------------------------------------------------------------------ */

export interface LiveTurnProps {
  streamingContent?: string;
  streamingReasoning?: string;
  activeTool?: string;
}

export function LiveTurn({ streamingContent, streamingReasoning, activeTool }: LiveTurnProps) {
  return (
    <Box flexDirection="column" paddingX={0}>
      {streamingReasoning && (
        <Box
          marginY={1}
          paddingLeft={2}
          borderStyle="round"
          borderColor="gray"
          flexDirection="column"
        >
          <Text color="gray.dim">Thinking Process:</Text>
          <Text color="gray.dim">{truncateLines(streamingReasoning, 5)}</Text>
        </Box>
      )}

      {streamingContent && (
        <Box marginY={1} flexDirection="column">
          <Box marginBottom={0}>
            <Text color="magenta.bold">Claude </Text>
            <Text color="cyan.bold">⠋</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={1}>
            {renderMarkdown(tailLines(streamingContent, 10))}
            <Text color="cyan">▋</Text>
          </Box>
        </Box>
      )}

      {activeTool && (
        <Box marginY={0} paddingLeft={2}>
          <Text color="cyan.bold">⠋ Running </Text>
          <Text color="white.bold">{activeTool}...</Text>
        </Box>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* Per-message rendering (used by the Static transcript).              */
/* ------------------------------------------------------------------ */

const renderMarkdown = (text: string): React.ReactElement[] => {
  const lines = text.split("\n");
  const elements: React.ReactElement[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("```")) {
      if (inCodeBlock) {
        elements.push(
          <Box
            key={`code-${i}`}
            flexDirection="column"
            paddingX={1}
            marginY={0}
            borderStyle="round"
            borderColor="gray"
          >
            {codeBlockLang && (
              <Text color="cyan.dim">[{codeBlockLang}]</Text>
            )}
            <Text color="green">{codeBlockLines.join("\n")}</Text>
          </Box>
        );
        codeBlockLines = [];
        inCodeBlock = false;
        codeBlockLang = "";
      } else {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (line.startsWith("# ")) {
      elements.push(
        <Box key={`h1-${i}`} marginTop={1}>
          <Text color="cyan.bold">{line.slice(2)}</Text>
        </Box>
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <Box key={`h2-${i}`} marginTop={1}>
          <Text color="white.bold">{line.slice(3)}</Text>
        </Box>
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <Box key={`h3-${i}`} marginTop={0}>
          <Text color="yellow.bold">{line.slice(4)}</Text>
        </Box>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <Box key={`li-${i}`} paddingLeft={2}>
          <Text color="cyan">• </Text>
          <Text color="white">{renderInline(line.slice(2))}</Text>
        </Box>
      );
    } else if (line.startsWith("> ")) {
      elements.push(
        <Box key={`quote-${i}`} paddingLeft={2} borderStyle="single" borderColor="gray">
          <Text color="gray.dim">{renderInline(line.slice(2))}</Text>
        </Box>
      );
    } else if (line.trim() === "") {
      elements.push(<Box key={`empty-${i}`} height={1} />);
    } else {
      elements.push(
        <Box key={`p-${i}`} marginY={0}>
          <Text color="white">{renderInline(line)}</Text>
        </Box>
      );
    }
  }

  if (inCodeBlock && codeBlockLines.length) {
    elements.push(
      <Box
        key="code-open"
        flexDirection="column"
        paddingX={1}
        borderStyle="round"
        borderColor="gray"
      >
        <Text color="green">{codeBlockLines.join("\n")}</Text>
      </Box>
    );
  }

  return elements;
};

const renderInline = (str: string): React.ReactNode => {
  // Splits by inline backticks `code`
  const parts = str.split(/(`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <Text key={idx} color="yellow">
          {part.slice(1, -1)}
        </Text>
      );
    }
    return part;
  });
};

const renderToolCallSummary = (name: string, argsStr: string): string => {
  try {
    const args = JSON.parse(argsStr);
    if (name === "Bash" && args.command) return `$ ${args.command}`;
    if (name === "Read" && args.file_path) return args.file_path;
    if (name === "Write" && args.file_path) return args.file_path;
    if (name === "Edit" && args.file_path) return args.file_path;
    if (name === "Glob" && args.pattern) return `pattern: "${args.pattern}"`;
    if (name === "Grep" && args.pattern) return `regex: "${args.pattern}"`;
    if (name === "Task" && args.subagent) return `subagent: ${args.subagent}`;
    if (name.startsWith("rea_") || name.startsWith("mcp__rea__")) {
      const target = args.target || args.query || args.tool_name || "";
      return target ? `target: "${target}"` : "";
    }
    return Object.entries(args)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .slice(0, 2)
      .join(", ");
  } catch {
    return argsStr.slice(0, 60);
  }
};

const truncateLines = (str: string, maxLines: number): string => {
  const lines = str.trim().split("\n");
  if (lines.length <= maxLines) return str.trim();
  return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
};

// Keep only the TAIL of the streaming text. The dynamic frame must stay
// viewport-sized regardless of how long the in-flight answer grows; the full
// message flushes into the <Static> transcript when the turn ends.
const tailLines = (str: string, maxLines: number): string => {
  const lines = str.split("\n");
  if (lines.length <= maxLines) return str;
  return (
    `[... ${lines.length - maxLines} earlier lines]` +
    "\n" +
    lines.slice(-maxLines).join("\n")
  );
};

export const renderMessage = (msg: Message, i: number): React.ReactElement | null => {
  switch (msg.role) {
    case "user":
      return (
        <Box key={i} marginY={1} flexDirection="column">
          <Box>
            <Text color="cyan.bold">❯ </Text>
            <Text color="cyan.bold">{msg.content}</Text>
          </Box>
        </Box>
      );

    case "assistant":
      if (!msg.content && msg.tool_calls?.length) {
        return (
          <Box key={i} flexDirection="column" marginY={0}>
            {msg.tool_calls.map((tc: ToolCall, idx: number) => (
              <Box key={idx} paddingLeft={2} marginY={0}>
                <Text color="cyan">● </Text>
                <Text color="white.bold">{tc.function.name}</Text>
                <Text color="gray.dim">
                  ({renderToolCallSummary(tc.function.name, tc.function.arguments)})
                </Text>
              </Box>
            ))}
          </Box>
        );
      }
      return (
        <Box key={i} marginY={1} flexDirection="column">
          <Box marginBottom={0}>
            <Text color="magenta.bold">Claude </Text>
            <Text color="gray.dim">• FA Code</Text>
          </Box>
          <Box flexDirection="column" paddingLeft={1}>
            {renderMarkdown(msg.content ?? "")}
          </Box>
        </Box>
      );

    case "tool": {
      const isError =
        (msg.content && msg.content.startsWith("Error")) ||
        (msg.content && msg.content.startsWith("Permission denied"));
      const toolName = msg.name || "Tool";

      return (
        <Box key={i} marginY={0} paddingLeft={4} flexDirection="column">
          <Box>
            <Text color={isError ? "red.bold" : "green"}>
              {isError ? "✖ " : "✔ "}
            </Text>
            <Text color={isError ? "red" : "gray"}>
              {toolName}: {truncateLines(msg.content ?? "", 3)}
            </Text>
          </Box>
        </Box>
      );
    }

    case "system":
      if (msg.content?.startsWith("Session started")) return null;
      if (msg.content?.startsWith("[Context compacted]")) {
        return (
          <Box key={i} marginY={1} paddingLeft={2} borderStyle="round" borderColor="yellow">
            <Text color="yellow">⚡ {msg.content}</Text>
          </Box>
        );
      }
      return null;

    default:
      return null;
  }
};
