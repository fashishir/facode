import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface SelectItem {
  label: string;
  /** Muted text after the label (endpoint URL, model, ...). */
  detail?: string;
  /** Small highlighted tag (active / built-in / free). */
  badge?: string;
}

export interface SelectListProps {
  title: string;
  items: SelectItem[];
  /** Index highlighted on open (default 0). */
  initialIndex?: number;
  /** Rows rendered at once — the window follows the selection. */
  maxRows?: number;
  /** Shown under the title when there is nothing to pick. */
  emptyText?: string;
  hint?: string;
  /** Deactivate while another prompt owns the keyboard. */
  isActive?: boolean;
  onSelect?: (index: number) => void;
  onCancel?: () => void;
}

/**
 * Arrow-key selection list rendered into the live (dynamic) part of the TUI —
 * Ink owns stdin, so this is how FA Code offers CLI-style choosers (model,
 * provider) from inside the chat box. Long lists scroll a window instead of
 * re-rendering hundreds of rows on every keypress.
 */
export function SelectList({
  title,
  items,
  initialIndex = 0,
  maxRows = 12,
  emptyText = "(nothing to show)",
  hint = "↑/↓ move   Enter select   Esc cancel",
  isActive = true,
  onSelect,
  onCancel,
}: SelectListProps) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1))
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        onCancel?.();
      } else if (key.return) {
        if (items.length) onSelect?.(index);
      } else if (key.upArrow) {
        setIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setIndex((i) => Math.min(items.length - 1, i + 1));
      }
    },
    { isActive }
  );

  // Keep the highlighted row inside the visible window, centred when possible.
  const start = Math.max(
    0,
    Math.min(index - Math.floor(maxRows / 2), Math.max(0, items.length - maxRows))
  );
  const visible = items.slice(start, start + maxRows);
  const hiddenBelow = Math.max(0, items.length - (start + visible.length));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginY={1}
    >
      <Text color="cyan.bold">{title}</Text>
      {items.length === 0 ? (
        <Text color="gray.dim">{emptyText}</Text>
      ) : (
        <>
          {start > 0 && <Text color="gray.dim">  ↑ {start} above</Text>}
          {visible.map((item, i) => {
            const abs = start + i;
            const selected = abs === index;
            return (
              <Box key={`${item.label}#${abs}`} flexDirection="row">
                <Text color={selected ? "cyan.bold" : "gray"}>{selected ? "❯ " : "  "}</Text>
                <Text color={selected ? "white.bold" : "white"}>{item.label}</Text>
                {item.badge ? <Text color="yellow.dim"> {item.badge}</Text> : null}
                {item.detail ? <Text color="gray.dim">  {item.detail}</Text> : null}
              </Box>
            );
          })}
          {hiddenBelow > 0 && <Text color="gray.dim">  ↓ {hiddenBelow} below</Text>}
        </>
      )}
      <Text color="gray.dim">{hint}</Text>
    </Box>
  );
}
