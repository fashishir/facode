import { makeTool, type Tool, type ToolContext, type ToolResult } from "@/tools/types";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { extname, resolve, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import { resolveReaCli, getActiveMcpManager } from "@/mcp";

/** Direct CLI wrappers for core REA capabilities as a fallback when rea-mcp is not running. */

function runRea(args: string[], cwd: string, maxBuffer = 100 * 1024 * 1024): string {
  const { command, args: cliArgs, shell } = resolveReaCli(args);
  return execFileSync(command, cliArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer,
    shell,
    timeout: 120_000,
  });
}

/** Like runRea, but tolerates non-zero exit codes (e.g. `rea doctor` reports unhealthy engines). */
function runReaTolerant(args: string[], cwd: string): { out: string; failed: boolean } {
  try {
    return { out: runRea(args, cwd), failed: false };
  } catch (e: any) {
    const out = [e?.stdout, e?.stderr].filter(Boolean).join("\n");
    if (out) return { out, failed: true };
    throw e;
  }
}

export const reaAnalyzeTool = makeTool({
  name: "rea_analyze",
  description:
    "Statically reconstruct and summarize a local application, binary, or JavaScript/Electron bundle using REA.",
  schema: z.object({
    target: z.string().describe("Target file/directory path or URL to analyze"),
  }),
  permission: "read",
  async execute(ctx: ToolContext, input: { target: string }): Promise<ToolResult> {
    const targetPath = resolve(ctx.cwd, input.target);
    try {
      const out = runRea(["analyze", targetPath], ctx.cwd);
      return { output: out };
    } catch (e: any) {
      const partial = [e?.stdout, e?.stderr].filter(Boolean).join("\n");
      return {
        output: partial || `REA analyze failed: ${e?.message ?? e}`,
        error: true,
      };
    }
  },
});

export const reaDecompileTool = makeTool({
  name: "rea_decompile",
  description:
    "Decompile a binary, managed assembly (.NET), APK class, or JavaScript bundle to readable source code using REA.",
  schema: z.object({
    target: z.string().describe("Target binary or bundle file path"),
    item: z.string().optional().describe("Class name, procedure name, or symbol to decompile"),
  }),
  permission: "read",
  async execute(ctx: ToolContext, input: { target: string; item?: string }): Promise<ToolResult> {
    const targetPath = resolve(ctx.cwd, input.target);
    const args = ["decompile", targetPath];
    if (input.item) args.push(input.item);
    try {
      const out = runRea(args, ctx.cwd);
      return { output: out };
    } catch (e: any) {
      const partial = [e?.stdout, e?.stderr].filter(Boolean).join("\n");
      return {
        output: partial || `REA decompile failed: ${e?.message ?? e}`,
        error: true,
      };
    }
  },
});

export const reaDoctorTool = makeTool({
  name: "rea_doctor",
  description: "Check available REA analysis engines (Hopper, Ghidra, IDA, JADX), MCP status, and reverse engineering environment health.",
  schema: z.object({}),
  permission: "read",
  async execute(ctx: ToolContext): Promise<ToolResult> {
    try {
      const { out } = runReaTolerant(["doctor"], ctx.cwd);
      return { output: out };
    } catch (e: any) {
      return { output: `REA doctor failed: ${e?.stderr || e?.message || e}`, error: true };
    }
  },
});

export const reaSearchToolsTool = makeTool({
  name: "rea_search_tools",
  description:
    "Search REA's 200+ reverse engineering MCP tools by keyword (e.g. 'frida', 'android', 'apk', 'decompile', 'xrefs', 'pe', 'ida', 'wasm', 'sqlite', 'symbols').",
  schema: z.object({
    query: z.string().describe("Keyword to match against tool names and descriptions"),
  }),
  permission: "read",
  async execute(_ctx: ToolContext, input: { query: string }): Promise<ToolResult> {
    const mcp = getActiveMcpManager();
    if (!mcp) {
      return { output: "REA MCP manager is not running.", error: true };
    }
    const matches = mcp.searchTools(input.query);
    if (!matches.length) {
      return { output: `No REA tools matching "${input.query}" found. Try broader keywords like 'inspect', 'binary', 'code', 'strings', or 'dump'.` };
    }
    const formatted = matches
      .map((t) => {
        const params = Object.keys((t.inputSchema as any)?.properties ?? {}).join(", ");
        return `- ${t.name}: ${t.description || "No description"} (args: ${params || "none"})`;
      })
      .join("\n");
    return {
      output: `Found ${matches.length} REA tool(s) matching "${input.query}":\n\n${formatted}`,
    };
  },
});

export const reaCallTool = makeTool({
  name: "rea_call_tool",
  description:
    "Invoke any specific REA MCP tool dynamically. Use rea_search_tools to discover tool names and their parameters.",
  schema: z.object({
    tool_name: z.string().describe("The exact name of the REA tool (e.g. 'list_strings', 'inspect_binary_layout', 'binary_overview')"),
    arguments: z
      .record(z.any())
      .optional()
      .describe("Tool input arguments as a JSON object"),
  }),
  permission: "read",
  async execute(_ctx: ToolContext, input: { tool_name: string; arguments?: Record<string, any> }): Promise<ToolResult> {
    const mcp = getActiveMcpManager();
    if (!mcp) {
      return { output: "REA MCP manager is not active.", error: true };
    }
    const res = await mcp.callTool(input.tool_name, input.arguments ?? {});
    return { output: res.output, error: res.error };
  },
});

export const reaTriageTool = makeTool({
  name: "rea_triage",
  description:
    "Analyze a target file or URL to determine its artifact type and recommend the optimal REA reverse engineering workflow based on the REA skill matrix.",
  schema: z.object({
    target: z.string().describe("Target file path or directory to triage"),
  }),
  permission: "read",
  async execute(ctx: ToolContext, input: { target: string }): Promise<ToolResult> {
    const p = resolve(ctx.cwd, input.target);
    const exists = existsSync(p);
    const ext = extname(p).toLowerCase();
    const base = basename(p);

    const recommendations: string[] = [];
    let artifactType = "Unknown / Generic";

    if (ext === ".asar" || base === "app.asar") {
      artifactType = "Electron ASAR Archive";
      recommendations.push(
        "1. Run `rea_call_tool(tool_name='analyze_javascript_application', arguments={path: '" + p.replace(/\\/g, "/") + "'})`",
        "2. Inspect packages and entrypoints",
        "3. Use `rea_decompile` or `read` on unpacked sources"
      );
    } else if (ext === ".apk" || ext === ".xapk") {
      artifactType = "Android APK Package";
      recommendations.push(
        "1. Run `rea_call_tool(tool_name='inspect_android_package', arguments={apk_path: '" + p.replace(/\\/g, "/") + "'})`",
        "2. For specific classes/methods: `inspect_android_class` or `inspect_android_method`",
        "3. For resource decoding: `decode_android_resources`"
      );
    } else if (ext === ".exe" || ext === ".dll" || ext === ".sys") {
      artifactType = "Windows PE Binary / Assembly";
      recommendations.push(
        "1. Check if .NET: `rea_call_tool(tool_name='inspect_managed_artifact', arguments={path: '" + p.replace(/\\/g, "/") + "'})`",
        "2. For native PE: `rea_call_tool(tool_name='open_binary', arguments={path: '" + p.replace(/\\/g, "/") + "'})`",
        "3. Reconstruct layout & strings: `inspect_binary_layout`, `search_strings`, `list_procedures`",
        "4. Decompile symbols: `rea_decompile` or `procedure_pseudo_code`"
      );
    } else if (ext === ".dylib" || ext === ".app" || ext === "") {
      artifactType = "Mach-O / ELF / Native Binary";
      recommendations.push(
        "1. Initialize session: `rea_call_tool(tool_name='open_binary', arguments={path: '" + p.replace(/\\/g, "/") + "'})`",
        "2. Overview: `rea_call_tool(tool_name='binary_overview', arguments={})`",
        "3. Disassemble / decompile: `procedure_assembly`, `list_names`, `find_xrefs_to_name`"
      );
    } else if (ext === ".js" || ext === ".mjs" || ext === ".bundle") {
      artifactType = "JavaScript / Web Bundle";
      recommendations.push(
        "1. Run `rea_call_tool(tool_name='analyze_web_bundle', arguments={path: '" + p.replace(/\\/g, "/") + "'})`",
        "2. Trace module imports: `trace_web_module_imports`",
        "3. Recover source maps / sources: `recover_javascript_sources`"
      );
    } else if (ext === ".wasm") {
      artifactType = "WebAssembly Binary";
      recommendations.push(
        "1. Inspect interface: `rea_call_tool(tool_name='inspect_wasm_artifact', arguments={path: '" + p.replace(/\\/g, "/") + "'})`",
        "2. Compare interfaces: `compare_wasm_interfaces`"
      );
    } else if (ext === ".db" || ext === ".sqlite" || ext === ".sqlite3") {
      artifactType = "SQLite Database";
      recommendations.push(
        "1. Inspect schema: `rea_call_tool(tool_name='inspect_sqlite_database', arguments={database_path: '" + p.replace(/\\/g, "/") + "'})`"
      );
    } else {
      artifactType = "Generic Binary / Artifact";
      recommendations.push(
        "1. Run `rea_analyze(target='" + p.replace(/\\/g, "/") + "')` for general static analysis",
        "2. Run `rea_search_tools(query='...')` to find domain-specific analysis tools"
      );
    }

    const report = [
      `### Target Triage Report: ${base}`,
      `- **Path**: ${p}`,
      `- **Exists**: ${exists ? "Yes" : "No"}`,
      exists ? `- **Size**: ${statSync(p).size} bytes` : "",
      `- **Artifact Type**: ${artifactType}`,
      "",
      "**Recommended REA Workflow (from REA Skill):**",
      ...recommendations,
    ]
      .filter(Boolean)
      .join("\n");

    return { output: report };
  },
});
