import { describe, it, expect } from "vitest";
import { reaTriageTool } from "@/tools/rea";

describe("REA Tools", () => {
  it("should triage an APK target correctly", async () => {
    const res = await reaTriageTool.execute(
      { cwd: process.cwd(), askPermission: async () => true },
      { target: "sample.apk" }
    );
    expect(res.output).toContain("Android APK Package");
    expect(res.output).toContain("inspect_android_package");
  });

  it("should triage an ASAR target correctly", async () => {
    const res = await reaTriageTool.execute(
      { cwd: process.cwd(), askPermission: async () => true },
      { target: "app.asar" }
    );
    expect(res.output).toContain("Electron ASAR Archive");
    expect(res.output).toContain("analyze_javascript_application");
  });

  it("should triage a Windows PE target correctly", async () => {
    const res = await reaTriageTool.execute(
      { cwd: process.cwd(), askPermission: async () => true },
      { target: "target.exe" }
    );
    expect(res.output).toContain("Windows PE Binary");
    expect(res.output).toContain("inspect_managed_artifact");
  });

  it("should triage a WebAssembly target correctly", async () => {
    const res = await reaTriageTool.execute(
      { cwd: process.cwd(), askPermission: async () => true },
      { target: "module.wasm" }
    );
    expect(res.output).toContain("WebAssembly Binary");
    expect(res.output).toContain("inspect_wasm_artifact");
  });
});
