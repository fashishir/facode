import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getSlashCommands, type SlashCommand } from "@/cli";

export interface InputBoxProps {
  onSubmit: (val: string) => void;
  placeholder?: string;
  history?: string[];
  /** While a permission prompt is open, deactivate so keys don't bleed into the input. */
  isActive?: boolean;
}

/**
 * The input box owns its own value state. Lifting the value into the root app
 * meant every keystroke re-rendered the entire TUI (banner + transcript +
 * status line), which is a major source of the flickering/garbled rendering on
 * Windows. With the value local, typing only re-renders this component.
 */
export function InputBox({
  onSubmit,
  placeholder = "Ask FA Code... (/ for commands)",
  history = [],
  isActive = true,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tempInput, setTempInput] = useState("");
  const slashCommands = getSlashCommands();

  // Keep cursor position clamped to string length
  useEffect(() => {
    if (cursorPos > value.length) {
      setCursorPos(value.length);
    }
  }, [value, cursorPos]);

  // Determine matching slash commands if typing a slash command
  const isSlash = value.startsWith("/") && !value.includes(" ");
  const matchingCommands: SlashCommand[] = isSlash
    ? slashCommands.filter((c) =>
        `/${c.name}`.startsWith(value.toLowerCase())
      )
    : [];

  useInput(
    (input, key) => {
      // 1. Shift+Enter -> Insert newline
      if (key.shift && key.return) {
        const next = value.slice(0, cursorPos) + "\n" + value.slice(cursorPos);
        setValue(next);
        setCursorPos(cursorPos + 1);
        return;
      }

      // 2. Plain Enter -> Submit
      if (key.return) {
        if (value.trim()) {
          onSubmit(value);
          setValue("");
          setHistoryIndex(-1);
          setTempInput("");
          setCursorPos(0);
        }
        return;
      }

      // 3. Tab -> Autocomplete slash command
      if (key.tab) {
        if (matchingCommands.length > 0) {
          const completed = `/${matchingCommands[0].name} `;
          setValue(completed);
          setCursorPos(completed.length);
        }
        return;
      }

      // 4. Up Arrow -> Navigate backwards in prompt history
      if (key.upArrow) {
        if (!history.length) return;
        if (historyIndex === -1) {
          setTempInput(value);
          const nextIndex = history.length - 1;
          setHistoryIndex(nextIndex);
          const past = history[nextIndex];
          setValue(past);
          setCursorPos(past.length);
        } else if (historyIndex > 0) {
          const nextIndex = historyIndex - 1;
          setHistoryIndex(nextIndex);
          const past = history[nextIndex];
          setValue(past);
          setCursorPos(past.length);
        }
        return;
      }

      // 5. Down Arrow -> Navigate forward in prompt history
      if (key.downArrow) {
        if (historyIndex !== -1) {
          if (historyIndex < history.length - 1) {
            const nextIndex = historyIndex + 1;
            setHistoryIndex(nextIndex);
            const past = history[nextIndex];
            setValue(past);
            setCursorPos(past.length);
          } else {
            setHistoryIndex(-1);
            setValue(tempInput);
            setCursorPos(tempInput.length);
          }
        }
        return;
      }

      // 6. Left Arrow
      if (key.leftArrow) {
        setCursorPos(Math.max(0, cursorPos - 1));
        return;
      }

      // 7. Right Arrow
      if (key.rightArrow) {
        setCursorPos(Math.min(value.length, cursorPos + 1));
        return;
      }

      // 8. Backspace
      if (key.backspace) {
        if (cursorPos > 0) {
          const next = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
          setValue(next);
          setCursorPos(cursorPos - 1);
        }
        return;
      }

      // 9. Delete key
      if (key.delete) {
        if (cursorPos < value.length) {
          const next = value.slice(0, cursorPos) + value.slice(cursorPos + 1);
          setValue(next);
        }
        return;
      }

      // 10. Escape -> clear input
      if (key.escape) {
        setValue("");
        setCursorPos(0);
        setHistoryIndex(-1);
        return;
      }

      // 11. Ctrl+A -> Move to start; Ctrl+E -> Move to end
      if (key.ctrl) {
        if (input === "a") {
          setCursorPos(0);
          return;
        }
        if (input === "e") {
          setCursorPos(value.length);
          return;
        }
        if (input === "k") {
          // Delete to end of line
          setValue(value.slice(0, cursorPos));
          return;
        }
        if (input === "u") {
          // Delete to start of line
          setValue(value.slice(cursorPos));
          setCursorPos(0);
          return;
        }
        return;
      }

      // 12. Standard character input
      if (input) {
        const next = value.slice(0, cursorPos) + input + value.slice(cursorPos);
        setValue(next);
        setCursorPos(cursorPos + input.length);
      }
    },
    { isActive }
  );

  // Render input string with visible cursor
  const renderInputWithCursor = () => {
    if (!value) {
      return (
        <Text>
          <Text inverse>{" "}</Text>
          <Text color="gray.dim">{placeholder.slice(1)}</Text>
        </Text>
      );
    }

    const before = value.slice(0, cursorPos);
    const at = value[cursorPos] || " ";
    const after = value.slice(cursorPos + 1);

    return (
      <Text>
        <Text color="white">{before}</Text>
        <Text inverse>{at}</Text>
        <Text color="white">{after}</Text>
      </Text>
    );
  };

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Slash command autocomplete suggestions */}
      {isSlash && matchingCommands.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          marginBottom={0}
        >
          <Text color="cyan.dim">Slash commands (Press Tab to autocomplete):</Text>
          {matchingCommands.slice(0, 5).map((cmd, i) => (
            <Box key={cmd.name}>
              <Text color="yellow.bold">/{cmd.name.padEnd(12)}</Text>
              <Text color="gray.dim">{cmd.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Main input prompt bar */}
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={0}
      >
        <Text color="cyan.bold">❯ </Text>
        {renderInputWithCursor()}
      </Box>
    </Box>
  );
}
