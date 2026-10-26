import React from "react";
import { Box, Text, useInput } from "ink";

export interface PermissionPromptProps {
  tool: string;
  input: unknown;
  level?: string;
  onDecision: (choice: "yes" | "always" | "no" | "plan") => void;
}

export function PermissionPrompt({ tool, input, level = "write", onDecision }: PermissionPromptProps) {
  useInput((char, key) => {
    if (char === "y" || char === "Y" || key.return) {
      onDecision("yes");
    } else if (char === "a" || char === "A") {
      onDecision("always");
    } else if (char === "p" || char === "P") {
      onDecision("plan");
    } else if (
      char === "d" ||
      char === "D" ||
      char === "n" ||
      char === "N" ||
      key.escape
    ) {
      onDecision("no");
    }
  });

  const renderActionPreview = (): React.ReactElement => {
    const inp = input as any;
    if (!inp) return <Text color="gray.dim">(no arguments)</Text>;

    if (tool === "Bash" && inp.command) {
      return (
        <Box flexDirection="column">
          <Text color="gray">Command:</Text>
          <Box paddingLeft={1} borderStyle="single" borderColor="gray">
            <Text color="yellow.bold">$ {inp.command}</Text>
          </Box>
        </Box>
      );
    }

    if (tool === "Write" && inp.file_path) {
      return (
        <Box flexDirection="column">
          <Text color="gray">Target file: <Text color="white.bold">{inp.file_path}</Text></Text>
          <Text color="gray.dim">Write content: {inp.content ? `${inp.content.length} characters` : ""}</Text>
        </Box>
      );
    }

    if (tool === "Edit" && inp.file_path) {
      const oldSnippet = (inp.old_string || "").slice(0, 120);
      const newSnippet = (inp.new_string || "").slice(0, 120);
      return (
        <Box flexDirection="column">
          <Text color="gray">File: <Text color="white.bold">{inp.file_path}</Text></Text>
          <Box flexDirection="column" paddingLeft={1} borderStyle="single" borderColor="gray">
            <Text color="red">- {oldSnippet}</Text>
            <Text color="green">+ {newSnippet}</Text>
          </Box>
        </Box>
      );
    }

    const json = JSON.stringify(inp, null, 2);
    return (
      <Box paddingLeft={1}>
        <Text color="gray">{json.slice(0, 200)}</Text>
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      <Box>
        <Text color="yellow.bold">⚠️  Permission Required </Text>
        <Text color="gray.dim">• Claude Code Security</Text>
      </Box>

      <Box marginY={1} flexDirection="column">
        <Box>
          <Text color="cyan.bold">Tool: </Text>
          <Text color="white.bold">{tool} </Text>
          <Text color="gray.dim">({level})</Text>
        </Box>
        {renderActionPreview()}
      </Box>

      <Box marginTop={1}>
        <Text>
          Press <Text color="green.bold">[y]</Text> Yes (once)  •  <Text color="blue.bold">[a]</Text> Always allow {tool}  •  <Text color="red.bold">[d]</Text> Deny  •  <Text color="yellow.bold">[p]</Text> Plan mode
        </Text>
      </Box>
    </Box>
  );
}
