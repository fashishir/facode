import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "@/permissions";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface StatusLineProps {
  text: string;
  thinking: boolean;
  permissionMode?: PermissionMode;
  turnCount?: number;
  /** Live REA/MCP status, e.g. "● 207 tools" or "○ connecting". */
  reaStatus?: string;
  /** Active model — shown live, refreshed after every slash command. */
  model?: string;
  /** Active provider name. */
  provider?: string;
  /** Session token usage text for the active model, e.g. "19.1k/1.0M". */
  usage?: string;
  /** Usage as a ratio of the 1M tracking budget (drives the segment color). */
  usageRatio?: number;
}

export function StatusLine({
  text,
  thinking,
  permissionMode = "default",
  turnCount,
  reaStatus,
  model,
  provider,
  usage,
  usageRatio = 0,
}: StatusLineProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!thinking) return;
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [thinking]);

  const modeColors: Record<PermissionMode, string> = {
    default: "cyan",
    plan: "yellow",
    auto: "magenta",
  };

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
      paddingY={0}
      marginTop={0}
      borderStyle="single"
      borderColor="gray"
    >
      <Box flexDirection="row">
        {thinking ? (
          <Text color="cyan.bold">{SPINNER_FRAMES[frame]} </Text>
        ) : (
          <Text color="green">✔ </Text>
        )}
        <Text color={thinking ? "white.bold" : "gray"}>{text}</Text>
      </Box>

      <Box flexDirection="row">
        {model && (
          <>
            <Text color="gray">model: </Text>
            <Text color="white">{model}</Text>
            <Text color="gray.dim"> │ </Text>
          </>
        )}
        {provider && (
          <>
            <Text color="gray">provider: </Text>
            <Text color="white">{provider}</Text>
            <Text color="gray.dim"> │ </Text>
          </>
        )}
        {reaStatus && (
          <>
            <Text color="gray">REA: </Text>
            <Text color={reaStatus.startsWith("●") ? "cyan" : "yellow"}>{reaStatus}</Text>
            <Text color="gray.dim"> │ </Text>
          </>
        )}
        {usage && (
          <>
            <Text color="gray">usage: </Text>
            <Text color={usageRatio >= 1 ? "magenta" : usageRatio >= 0.8 ? "yellow" : "gray"}>{usage}</Text>
            <Text color="gray.dim"> │ </Text>
          </>
        )}
        <Text color="gray">mode: </Text>
        <Text color={modeColors[permissionMode] || "cyan"}>[{permissionMode}]</Text>
        {turnCount !== undefined && (
          <Text color="gray.dim"> │ {turnCount} turns</Text>
        )}
        <Text color="gray.dim"> │ ^C cancel</Text>
      </Box>
    </Box>
  );
}
