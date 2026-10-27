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
import { SelectList } from "@/tui/select-list";
import { ModelPicker } from "@/tui/model-picker";
import { ProviderForm, type ProviderFormValues } from "@/tui/provider-form";
import type { Message, ToolCall } from "@/agent/types";
import { runAgentLoop } from "@/agent/loop";
import { summarizeMessages } from "@/agent/compaction";
import { compactSession, loadSession, appendSession } from "@/session/store";
import { executeSlash } from "@/cli";
import { defaultSystemPrompt, loadConfig, maskKey, resolveProviderOptions } from "@/config";
import { loadPermissions, savePermissions, decide, type PermissionMode } from "@/permissions";
import { addProvider, providerChoices } from "@/provider-commands";
import { TOKEN_BUDGET_PER_MODEL, budgetRatio, type ModelUsageEntry } from "@/agent/usage";
import { formatTokens } from "@/utils";

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

/** An in-TUI overlay opened from the chat box by a slash command's interactive flow. */
type TuiOverlay =
  | { kind: "model"; provider?: string }
  | { kind: "provider-list" }
  | { kind: "provider-form"; prefillName?: string };

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
  // Interactive chooser/form opened by a slash command; while set, the input box
  // stops consuming keys so ↑/↓/Enter reach the overlay.
  const [overlay, setOverlay] = useState<TuiOverlay | null>(null);

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
  const [modelUsage, setModelUsage] = useState<ModelUsageEntry[]>([]);
  const onModelSwitch = useCallback((from: string, to: string) => {
    setActiveModel(to);
    setStatus(`Switched model (quota): ${from} → ${to}`);
  }, []);

  // Per-model token usage (tracking only — never limits a request). Shown
  // live for the active model in the status line; /usage shows all models.
  const onUsage = useCallback((snapshot: ModelUsageEntry[]) => {
    setModelUsage(snapshot);
  }, []);
  const activeModelEntry = modelUsage.find(
    (e) => e.model.toLowerCase() === activeModel.toLowerCase()
  );
  const usedByActiveModel = activeModelEntry
    ? activeModelEntry.inputTokens + activeModelEntry.outputTokens
    : modelUsage.reduce((n, e) => n + e.inputTokens + e.outputTokens, 0);
  const usageRatio = activeModelEntry
    ? budgetRatio(activeModelEntry)
    : modelUsage.reduce((n, e) => n + budgetRatio(e), 0);

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

  // Rows for the `/provider use` picker (read only while that overlay is open).
  const providerOptions =
    overlay?.kind === "provider-list" ? providerChoices(props.cwd) : [];

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

  /** Append completed messages to the transcript (and the session log). */
  const appendMessages = (msgs: Message[]) => {
    const next = [...getHistory(), ...msgs];
    setHistory(next);
    persistNew(next);
  };

  /**
   * Slash commands may change the provider (/provider use) or the model
   * (/model <name>): re-read the config so the status line shows the active
   * pair live.
   */
  const refreshEndpoint = () => {
    const fresh = loadConfig(props.cwd);
    setActiveProvider(
      props.provider ?? fresh.activeProvider ?? fresh.provider ?? "openai"
    );
    setActiveModel(resolveProviderOptions(fresh).model || fresh.model || "");
  };

  /** Close an overlay, optionally logging the outcome (failure/cancel) to the transcript. */
  const closeOverlay = (message?: string) => {
    setOverlay(null);
    if (message) appendMessages([{ role: "assistant", content: message } as Message]);
  };

  /**
   * Run a slash command. Shared by the input box and the interactive overlays,
   * so a picker selection persists through exactly the same path as the typed
   * command (`/provider use <name>`, `/model <name>`).
   */
  const runSlash = async (text: string) => {
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
      // Interactive flows: `/model pick`, `/provider use` (no name) and
      // `/provider add` (no fields) open Ink overlays instead of printing text.
      tui: {
        openModelPicker: (provider) => setOverlay({ kind: "model", provider }),
        openProviderPicker: () => setOverlay({ kind: "provider-list" }),
        openProviderForm: (name) => setOverlay({ kind: "provider-form", prefillName: name }),
      },
    });
    if (out) {
      // Display the slash command and its response in the chat history.
      appendMessages([
        { role: "user", content: text } as Message,
        { role: "assistant", content: out } as Message,
      ]);
      setStatus("Ready");
    }
    refreshEndpoint();
  };

  /**
   * The guided provider form posts structured fields, so it calls `addProvider`
   * directly — the same function `/provider add` uses — rather than re-parsing a
   * command line. The echo masks the key.
   */
  const submitProviderForm = (values: ProviderFormValues) => {
    setOverlay(null);
    const out = addProvider({
      name: values.name,
      baseURL: values.baseURL,
      apiKey: values.apiKey,
      model: values.model || undefined,
      scope: "user",
      cwd: props.cwd,
    });
    appendMessages([
      {
        role: "user",
        content: `/provider add ${values.name} ${values.baseURL} ${maskKey(values.apiKey)}${values.model ? ` ${values.model}` : ""}`,
      } as Message,
      { role: "assistant", content: out } as Message,
    ]);
    setStatus(out.startsWith("✔") ? "Ready" : "Provider not saved");
    refreshEndpoint();
  };

  const handleSubmit = async (text: string) => {
    if (!text.trim() || busyRef.current || pendingApproval) return;
    setPromptHistory((prev) => [...prev, text]);

    // Slash commands
    if (text.startsWith("/")) {
      try {
        await runSlash(text);
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
        onUsage,
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
        isActive={!pendingApproval && !overlay}
      />

      {/* In-chat pickers/forms. They own the keyboard while open — the input box
          is deactivated above — and persist through runSlash/submitProviderForm. */}
      {overlay?.kind === "model" && (
        <ModelPicker
          cwd={props.cwd}
          provider={overlay.provider}
          currentModel={activeModel}
          onSelect={(model) => {
            setOverlay(null);
            runSlash(`/model ${model}`).catch((e: any) =>
              setStatus(`Error: ${e?.message ?? e}`)
            );
          }}
          onCancel={closeOverlay}
        />
      )}

      {overlay?.kind === "provider-list" && (
        <SelectList
          title="Select a provider"
          items={providerOptions.map((p) => ({
            label: p.name,
            badge:
              [p.active ? "active" : "", p.builtin ? "built-in" : ""]
                .filter(Boolean)
                .join(" ") || undefined,
            detail: `${p.baseURL}${p.model ? `  model: ${p.model}` : ""}`,
          }))}
          initialIndex={Math.max(0, providerOptions.findIndex((p) => p.active))}
          emptyText="No providers configured — use /provider add."
          onSelect={(i) => {
            const picked = providerOptions[i];
            setOverlay(null);
            runSlash(`/provider use ${picked.name}`).catch((e: any) =>
              setStatus(`Error: ${e?.message ?? e}`)
            );
          }}
          onCancel={() => closeOverlay()}
        />
      )}

      {overlay?.kind === "provider-form" && (
        <ProviderForm
          prefillName={overlay.prefillName}
          onCancel={() => setOverlay(null)}
          onSubmit={submitProviderForm}
        />
      )}

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
        usage={modelUsage.length ? `${formatTokens(usedByActiveModel)}/${formatTokens(TOKEN_BUDGET_PER_MODEL)}` : undefined}
        usageRatio={usageRatio}
      />
    </Box>
  );
}

export async function runTuiApp(props: TuiAppProps): Promise<void> {
  const { waitUntilExit } = render(<TuiApp {...props} />);
  await waitUntilExit();
}
