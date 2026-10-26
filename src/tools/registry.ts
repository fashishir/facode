import type { Tool } from "@/tools/types";
import { bashTool } from "@/tools/bash";
import { readTool } from "@/tools/read";
import { writeTool } from "@/tools/write";
import { editTool } from "@/tools/edit";
import { globTool } from "@/tools/glob";
import { grepTool } from "@/tools/grep";
import { taskTool } from "@/tools/task";
import {
  reaAnalyzeTool,
  reaDecompileTool,
  reaDoctorTool,
  reaSearchToolsTool,
  reaCallTool,
  reaTriageTool,
} from "@/tools/rea";

export class ToolRegistry {
  private tools = new Map<string, Tool<any>>();

  constructor() {
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    this.register(bashTool);
    this.register(readTool);
    this.register(writeTool);
    this.register(editTool);
    this.register(globTool);
    this.register(grepTool);
    this.register(taskTool);
    this.register(reaAnalyzeTool);
    this.register(reaDecompileTool);
    this.register(reaDoctorTool);
    this.register(reaSearchToolsTool);
    this.register(reaCallTool);
    this.register(reaTriageTool);
  }

  register(tool: Tool<any>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<any>[] {
    return Array.from(this.tools.values());
  }

  /** Return tools matching a pattern or list. Supports wildcards like "mcp__rea__*". */
  filter(allowed?: string[]): Tool<any>[] {
    if (!allowed || allowed.includes("*")) return this.list();
    const result: Tool<any>[] = [];
    for (const tool of this.tools.values()) {
      for (const pat of allowed) {
        if (pat === tool.name) {
          result.push(tool);
          break;
        }
        if (pat.endsWith("*") && tool.name.startsWith(pat.slice(0, -1))) {
          result.push(tool);
          break;
        }
      }
    }
    return result;
  }
}
