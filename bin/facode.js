#!/usr/bin/env node
// FA Code CLI entry point. Prefers the compiled dist (fast plain-node startup),
// falls back to live TypeScript via tsx only when dist/index.js is missing
// (e.g. a fresh checkout before `npm run build`).
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const here = dirname(__filename);
const distEntry = resolve(here, "..", "dist", "index.js");
const tsEntry = resolve(here, "..", "src", "index.ts");
const localTsx = resolve(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

if (existsSync(distEntry)) {
  await import("file://" + distEntry.replace(/\\/g, "/"));
} else if (existsSync(tsEntry)) {
  if (existsSync(localTsx)) {
    const res = spawnSync(process.execPath, [localTsx, tsEntry, ...process.argv.slice(2)], {
      stdio: "inherit",
    });
    process.exit(res.status ?? 0);
  } else {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "npx.cmd" : "npx";
    const res = spawnSync(cmd, ["tsx", `"${tsEntry}"`, ...process.argv.slice(2)], {
      stdio: "inherit",
      shell: isWindows,
    });
    process.exit(res.status ?? 0);
  }
} else {
  console.error("FA Code entry point not found (neither dist/index.js nor src/index.ts exist).");
  console.error("Run `npm run build` (or commit src/index.ts and ensure tsx is installed).");
  process.exit(1);
}
