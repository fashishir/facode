import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, render, useApp, useInput } from "ink";
import {
  ChatTranscript,
  LiveTurn,
  type TranscriptItem,
} from "@/tui/chat-history";
import { InputBox } from "@/tui/input-box";
import { StatusLine } from "@/tui/status-line";
import { PermissionPrompt } from "@/tui/permission-prompt";
import type { Message, ToolCall } from "@/agent/types";
import { runAgentLoop } from "@/agent/loop";
import { summarizeMessages } from "@/agent/compaction";
import { compactSession, loadSession, appendSession } from "@/session/store";
import { executeSlash } from "@/cli";
import { defaultSystemPrompt, loadConfig, resolveProviderOptions } from "@/config";
import { loadPermissions, savePermissions, decide, type PermissionMode } from "@/permissions";

export interface TuiAppProps {
  cwd: string;
  sessionId: string;
  history: Message[];
  initialPrompt?: string;
  /** CLI version, shown in the banner. */
  version?: string;
  /** Fixed tool list, or getter resolved when each turn starts (live MCP). */
  tools?: any[] | (() => any[]);
  permissionGate?: (tool: string, input: unknown, level: string) => Promise<boolean>;
  getProviderOptions: () => any;
  mcp: any;
  persistNew?: (msgs: Message[]) => void;
  getHistory?: () => Message[];
  setHistory?: (msgs: Message[]) => void;
  provider?: string;
}

interface PendingApproval {
  tool: string;
  input: unknown;
  level: string;
  resolve: (choice: "yes" | "always" | "no" | "plan") => void;
}

export function TuiApp(props: TuiAppProps) {
  const { exit } = useApp();
  const historyRef = useRef<Message[]>(props.history);
  const [messages, setMessages] = useState<Message[]>(props.history);
  const [transcriptEpoch, setTranscriptEpoch] = useState(0);
  const [isThinking, setIsThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [activeTool, setActiveTool] = useState<string | undefined>();
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("Ready");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);

  const busyRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const cfg = loadConfig(props.cwd);
  const permStateRef = useRef(loadPermissions(props.cwd));
  const [activeProvider, setActiveProvider] = useState(
    props.provider ?? cfg.activeProvider ?? cfg.provider ?? "openai"
  );
  // Live model display for the status line (refreshed after slash commands —
  // the banner above stays a startup snapshot, Claude Code style).
  const [activeModel, setActiveModel] = useState(
    resolveProviderOptions(cfg).model || cfg.model || ""
  );
  // Auto-failover can switch the active model mid-turn when the previous one
  // hits a quota/rate-limit error; the status line reflects the current model.
  const onModelSwitch = useCallback((from: string, to: string) => {
    setActiveModel(to);
    setStatus(`Switched model (quota): ${from} → ${to}`);
  }, []);

  const getHistory = props.getHistory ?? (() => historyRef.current);

  // Resolve the (potentially getter-based) tool list: builtins are available
  // immediately, MCP tools flow in once the background MCP start connects.
  const resolveTools = (): any[] =>
    typeof props.tools === "function" ? props.tools() : props.tools ?? [];
  const [toolCount, setToolCount] = useState<number>(resolveTools().length);
  const [mcpReady, setMcpReady] = useState<boolean>(
    !!props.mcp?.listMcpTools?.("rea")?.length
  );
  useEffect(() => {
    if (mcpReady) return;
    // Poll while the background MCP start is still connecting.
    const iv = setInterval(() => {
      const count = props.mcp?.listMcpTools?.("rea")?.length ?? 0;
      setMcpReady(count > 0);
      setToolCount(resolveTools().length);
    }, 500);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpReady]);

  /**
   * Central history setter. Appends (same object refs for the old prefix) let
   * the <Static> transcript flush just the new messages; replacements
   * (/clear, /compact, session load) bump the transcript epoch, which remounts
   * the <Static> tree so it re-flushes the new transcript exactly once.
   */
  const setHistory = (msgs: Message[]) => {
    const prev = historyRef.current;
    historyRef.current = msgs;
    const isAppend =
      msgs.length >= prev.length && prev.every((m, i) => msgs[i] === m);
    if (!isAppend) setTranscriptEpoch((e) => e + 1);
    setMessages(msgs);
    props.setHistory?.(msgs);
  };

  const persistNew =
    props.persistNew ??
    ((msgs: Message[]) => {
      for (const msg of msgs) {
        appendSession(props.sessionId, msg, { cwd: props.cwd });
      }
    });

  // Global Ctrl+C handler: abort current turn if active, otherwise exit
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (busyRef.current && abortControllerRef.current) {
        abortControllerRef.current.abort();
        setStatus("Interrupted by user");
      } else {
        exit();
      }
    }
  });

  // Static transcript items: banner first (flushed once at startup), then the
  // completed messages. Static renders each item exactly once; the epoch key
  // above remounts it whenever the transcript is replaced rather than grown.
  const [bannerItem] = useState<TranscriptItem>(() => ({
    kind: "banner",
    banner: {
      model: cfg.model ?? "default",
      provider: props.provider ?? cfg.activeProvider ?? cfg.provider ?? "openai",
      cwd: props.cwd,
      version: props.version,
    },
  }));
  const transcriptItems: TranscriptItem[] = [
    bannerItem,
    ...messages.map((message) => ({ kind: "message" as const, message })),
  ];

  // Handle initial prompt
  useEffect(() => {
    if (props.initialPrompt && historyRef.current.length === 0) {
      handleSubmit(props.initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialPrompt]);

  // Interactive permission gate
  const interactivePermissionGate = async (
    tool: string,
    input: unknown,
    level: string
  ): Promise<boolean> => {
    const allowed = decide(
      permStateRef.current,
      tool,
      level as "read" | "write" | "exec" | "none"
    );
    if (allowed) return true;
    if (permStateRef.current.mode === "plan") return false;

    return new Promise<boolean>((resolve) => {
      setPendingApproval({
        tool,
        input,
        level,
        resolve: (choice) => {
          if (choice === "always") {
            permStateRef.current.alwaysAllow.add(tool);
            savePermissions(props.cwd, permStateRef.current);
            resolve(true);
          } else if (choice === "yes") {
            resolve(true);
          } else if (choice === "plan") {
            permStateRef.current.mode = "plan";
            setPermissionMode("plan");
            savePermissions(props.cwd, permStateRef.current);
            resolve(false);
          } else {
            resolve(false);
          }
        },
      });
    });
  };

  const handleSubmit = async (text: string) => {
    if (!text.trim() || busyRef.current || pendingApproval) return;
    setPromptHistory((prev) => [...prev, text]);

    // Slash commands
    if (text.startsWith("/")) {
      try {
        const out = await executeSlash(text, {
          cwd: props.cwd,
          messages: getHistory(),
          setMessages: setHistory,
          setStatus,
          setPermissionMode: (mode) => {
            setPermissionMode(mode);
            permStateRef.current.mode = mode;
            savePermissions(props.cwd, permStateRef.current);
          },
          setProvider: (name) => {
            // Display-only. Persistence already happened in useProvider
            // (provider-commands) with the correct per-layer write; saving the
            // MERGED config here used to leak user values — including real API
            // keys — into the project's .facode/config.json.
            setActiveProvider(name);
            setStatus(`Provider: ${name}`);
          },
          permissionMode,
          compact: async () => {
            await compactSession(props.sessionId, 6, (msgs) =>
              summarizeMessages(msgs, props.cwd)
            );
            setHistory(loadSession(props.sessionId));
          },
          exit: () => exit(),
        });
        if (out) {
          // Display slash command response in chat history as system message
          const msg: Message = {
            role: "assistant",
            content: out,
          };
          const next = [...getHistory(), { role: "user", content: text } as Message, msg];
          setHistory(next);
          persistNew(next);
          setStatus("Ready");
        }
        // Slash commands may change the provider (/provider use) or the model
        // (/model <name>): re-read the config so the status line shows the
        // active pair live.
        const fresh = loadConfig(props.cwd);
        setActiveProvider(
          props.provider ?? fresh.activeProvider ?? fresh.provider ?? "openai"
        );
        setActiveModel(resolveProviderOptions(fresh).model || fresh.model || "");
      } catch (e: any) {
        setStatus(`Error: ${e?.message ?? e}`);
      }
      return;
    }

    busyRef.current = true;
    setIsThinking(true);
    setStreamingContent("");
    setStreamingReasoning("");
    setActiveTool(undefined);
    setStatus("Thinking...");

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const activePrompt = defaultSystemPrompt(props.cwd);

      const { messages: updated } = await runAgentLoop(text, getHistory(), {
        cwd: props.cwd,
        systemPrompt: activePrompt,
        tools: resolveTools(),
        permissionGate: interactivePermissionGate,
        signal: abortController.signal,
        onDelta: (delta: string) => {
          setStreamingContent((prev) => prev + delta);
        },
        onReasoningDelta: (delta: string) => {
          setStreamingReasoning((prev) => prev + delta);
        },
        onToolCall: (call: ToolCall) => {
          setActiveTool(call.function?.name ?? "tool");
          setStatus(`Running ${call.function?.name}...`);
        },
        onToolResult: (tool: string, result: any) => {
          setActiveTool(undefined);
          setStatus(result.error ? `${tool} failed` : `${tool} finished`);
        },
        onModelSwitch,
        onTurnEnd: (msgs: Message[]) => {
          // Clear the live-stream area first, in the same batch as the history
          // update, so the finished message appears exactly once (in the
          // <Static> transcript) instead of momentarily in both places.
          setStreamingContent("");
          setStreamingReasoning("");
          setActiveTool(undefined);
          persistNew(msgs);
          setHistory(msgs);
        },
      });

      if (updated.at(-1)) setStatus(`Ready`);
    } catch (err: any) {
      if (abortController.signal.aborted) {
        setStatus("Interrupted by user");
      } else {
        setStatus(`Error: ${err?.message ?? err}`);
      }
    } finally {
      busyRef.current = false;
      setIsThinking(false);
      setStreamingContent("");
      setStreamingReasoning("");
      setActiveTool(undefined);
      abortControllerRef.current = null;
    }
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Completed transcript: flushed once per message into scrollback. The
          key remounts the <Static> tree when the transcript is replaced. */}
      <ChatTranscript key={transcriptEpoch} items={transcriptItems} />

      {/* Live turn: only the in-flight content stays in the dynamic buffer. */}
      <LiveTurn
        streamingContent={streamingContent}
        streamingReasoning={streamingReasoning}
        activeTool={activeTool}
      />

      {/* The input box stays mounted (its own text state survives prompts);
          it just stops consuming keys while a permission prompt is open. */}
      <InputBox
        onSubmit={handleSubmit}
        placeholder="Ask FA Code... (/ for commands, Enter to submit)"
        history={promptHistory}
        isActive={!pendingApproval}
      />

      {pendingApproval && (
        <PermissionPrompt
          tool={pendingApproval.tool}
          input={pendingApproval.input}
          level={pendingApproval.level}
          onDecision={(choice) => {
            pendingApproval.resolve(choice);
            setPendingApproval(null);
          }}
        />
      )}

      <StatusLine
        text={status}
        thinking={isThinking}
        permissionMode={permissionMode}
        turnCount={messages.length}
        model={activeModel || undefined}
        provider={activeProvider}
        reaStatus={mcpReady ? `● ${toolCount} tools` : "○ connecting"}
      />
    </Box>
  );
}

export async function runTuiApp(props: TuiAppProps): Promise<void> {
  const { waitUntilExit } = render(<TuiApp {...props} />);
  await waitUntilExit();
}
