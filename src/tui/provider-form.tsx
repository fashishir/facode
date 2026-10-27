import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { validateProviderInput } from "@/config";

export interface ProviderFormValues {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ProviderFormProps {
  /** Pre-fill the name (e.g. `/provider add myproxy`). */
  prefillName?: string;
  onCancel: () => void;
  onSubmit: (values: ProviderFormValues) => void;
}

type FieldKey = keyof ProviderFormValues;

const FIELDS: { key: FieldKey; label: string; hint: string }[] = [
  {
    key: "name",
    label: "Name",
    hint: "letters/digits/-/_ starting with a letter, e.g. myproxy",
  },
  {
    key: "baseURL",
    label: "Base URL",
    hint: "OpenAI-compatible endpoint, e.g. https://api.example.com/v1",
  },
  {
    key: "apiKey",
    label: "API key",
    hint: "the key itself, or env:MY_API_KEY to keep the secret in the environment",
  },
  {
    key: "model",
    label: "Model",
    hint: "optional default model — you can pick one later with /model pick",
  },
];

/**
 * Validate form input before it reaches `addProvider`. Name and base URL rules
 * (and their wording) come from `validateProviderInput` — the single source of
 * truth shared with the CLI — by isolating one field at a time against known
 * valid values, since that validator reports a single problem per call.
 */
export function validateProviderForm(
  values: ProviderFormValues
): { field: FieldKey; message: string } | null {
  const name = values.name.trim();
  const baseURL = values.baseURL.trim();
  const apiKey = values.apiKey.trim();

  const nameError = validateProviderInput({ name, baseURL: "https://example.com/v1" }, false);
  if (nameError) return { field: "name", message: nameError };

  const urlError = validateProviderInput({ name: "ok", baseURL }, false);
  if (urlError) return { field: "baseURL", message: urlError };

  if (!apiKey) {
    return {
      field: "apiKey",
      message: "An API key is required — or use env:VARNAME to reference an environment variable.",
    };
  }
  if (/^env:/i.test(apiKey) && !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(apiKey)) {
    return {
      field: "apiKey",
      message: "env: needs a variable name — e.g. env:MY_API_KEY",
    };
  }
  return null;
}

/**
 * Guided `provider add` form for the TUI. The CLI equivalent
 * (`interactiveAddProvider`) prompts through readline, which cannot work inside
 * Ink — there stdin belongs to the renderer — so this renders the same four
 * fields as a navigable overlay instead. Nothing is written until the last
 * field is submitted, and persistence still goes through `addProvider`.
 */
export function ProviderForm({ prefillName = "", onCancel, onSubmit }: ProviderFormProps) {
  const [values, setValues] = useState<ProviderFormValues>({
    name: prefillName,
    baseURL: "",
    apiKey: "",
    model: "",
  });
  const [activeIndex, setActiveIndex] = useState(prefillName ? 1 : 0);
  const [error, setError] = useState<{ field: FieldKey; message: string } | null>(null);

  const activeField = FIELDS[activeIndex].key;

  const trySubmit = () => {
    const problem = validateProviderForm(values);
    if (problem) {
      setError(problem);
      setActiveIndex(FIELDS.findIndex((f) => f.key === problem.field));
      return;
    }
    onSubmit({
      name: values.name.trim(),
      baseURL: values.baseURL.trim(),
      apiKey: values.apiKey.trim(),
      model: values.model.trim(),
    });
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (activeIndex === FIELDS.length - 1) trySubmit();
      else setActiveIndex((i) => i + 1);
      return;
    }
    if (key.tab || key.downArrow) {
      setActiveIndex((i) => Math.min(FIELDS.length - 1, i + 1));
      return;
    }
    if (key.upArrow) {
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.backspace || key.delete) {
      setError(null);
      setValues((v) => ({ ...v, [activeField]: v[activeField].slice(0, -1) }));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input) {
      setError(null);
      setValues((v) => ({ ...v, [activeField]: v[activeField] + input }));
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginY={1}
    >
      <Text color="cyan.bold">Add a custom provider</Text>
      <Text color="gray.dim">Any OpenAI-compatible endpoint. Saved to ~/.facode/config.json.</Text>
      {FIELDS.map((field, i) => {
        const focused = i === activeIndex;
        const value = values[field.key];
        const required = field.key !== "model";
        return (
          <Box key={field.key} flexDirection="column">
            <Box flexDirection="row">
              <Text color={focused ? "cyan.bold" : "gray"}>
                {focused ? "❯ " : "  "}
                {field.label.padEnd(10)}
              </Text>
              <Text color={focused ? "white" : "white.dim"}>
                {value}
              </Text>
              {focused && <Text inverse> </Text>}
              {!value && <Text color="gray.dim">{required ? "(required)" : "(optional)"}</Text>}
            </Box>
            {focused && <Text color="gray.dim">{"    "}{field.hint}</Text>}
            {error?.field === field.key && <Text color="red">{"    ✖ "}{error.message}</Text>}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="gray.dim">
          Tab/↑↓ switch field   Enter next / submit   Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
