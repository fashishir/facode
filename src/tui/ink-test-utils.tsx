import type React from "react";
import type { Instance } from "ink";
import { render as inkRender } from "ink";

// Thin wrapper around Ink's render() that accepts mock stdin/stdout streams
// (PassThrough with isTTY=true), so components can be smoke-tested without a
// real terminal. Ink's render options accept custom streams but the public
// types are stricter, hence the casts here.

export type InkInstance = Instance;

export interface MockRenderOptions {
  stdout: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
}

export function render(
  element: React.ReactElement,
  options: MockRenderOptions
): InkInstance {
  return inkRender(element, {
    stdout: options.stdout as any,
    stdin: options.stdin as any,
    exitOnCtrlC: false,
    patchConsole: false,
  });
}
