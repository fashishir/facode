#!/usr/bin/env node
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Entry point that runs the compiled or tsx-supported index
try {
  await import("../dist/index.js");
} catch {
  // If dist doesn't exist, fallback to tsx
  const { spawnSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const entry = resolve(import.meta.dirname ?? ".", "../src/index.ts");
  const res = spawnSync("npx", ["tsx", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: true,
  });
  process.exit(res.status ?? 0);
}
