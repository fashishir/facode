import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { getModelChoices, type ModelChoices } from "@/provider-commands";
import { SelectList, type SelectItem } from "@/tui/select-list";

export interface ModelPickerProps {
  cwd: string;
  /** Registered provider to list; omit to use the active/resolved endpoint. */
  provider?: string;
  /** Currently configured model — highlighted when the picker opens. */
  currentModel?: string;
  onSelect: (model: string) => void;
  /** `message` carries a reason worth showing in the transcript (failure/cancel). */
  onCancel: (message?: string) => void;
}

/**
 * Interactive model chooser for the TUI (`/model pick`): fetches the endpoint's
 * `/models` (a read-only GET — no chat quota), lists them free-first, and
 * persists the chosen id through the normal `/model <id>` path. Unlike
 * `pickModel` (CLI readline), this one never touches stdin directly: Ink owns
 * it, so it renders arrow-key navigation instead of a numbered prompt.
 */
export function ModelPicker({
  cwd,
  provider,
  currentModel,
  onSelect,
  onCancel,
}: ModelPickerProps) {
  const [choices, setChoices] = useState<ModelChoices | null>(null);

  useEffect(() => {
    let alive = true;
    getModelChoices(cwd, provider).then((result) => {
      if (alive) setChoices(result);
    });
    return () => {
      alive = false;
    };
  }, [cwd, provider]);

  // While loading (and after a failure) the list is not mounted, so this owns
  // the keys; once the list renders, SelectList takes over.
  useInput(
    (_input, key) => {
      if (key.escape || key.return) {
        onCancel(choices && !choices.ok ? choices.message : undefined);
      }
    },
    { isActive: !choices?.ok }
  );

  if (!choices) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
        <Text color="gray.dim">Fetching models…</Text>
      </Box>
    );
  }

  if (!choices.ok) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="red"
        paddingX={1}
        marginY={1}
      >
        <Text color="red.bold">Model picker</Text>
        <Text color="red">{choices.message}</Text>
        <Text color="gray.dim">Enter/Esc to close</Text>
      </Box>
    );
  }

  const items: SelectItem[] = choices.models.map((id, i) => ({
    label: id,
    badge: i < choices.freeCount ? "(free)" : undefined,
  }));

  return (
    <SelectList
      title={`Select a model — ${choices.label} (${choices.models.length} available, free first)`}
      items={items}
      initialIndex={Math.max(0, choices.models.indexOf(currentModel ?? ""))}
      onSelect={(i) => onSelect(choices.models[i])}
      onCancel={() => onCancel("Pick canceled — model unchanged.")}
    />
  );
}
