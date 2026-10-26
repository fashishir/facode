import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { truncate, formatBytes, numberLines, expandHome, sleep } from "@/utils";

describe("truncate", () => {
  it("should return string as-is if under limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("should truncate with ellipsis if over limit", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
  });

  it("should handle exact limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });
});

describe("formatBytes", () => {
  it("should format bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("should format KB", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("should format MB", () => {
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

describe("numberLines", () => {
  it("should number lines starting from 1", () => {
    expect(numberLines("a\nb\nc")).toBe("1\ta\n2\tb\n3\tc");
  });

  it("should start from offset", () => {
    expect(numberLines("a\nb", 5)).toBe("5\ta\n6\tb");
  });

  it("should pad numbers", () => {
    expect(numberLines("a\nb\nc", 10)).toBe("10\ta\n11\tb\n12\tc");
  });
});

describe("expandHome", () => {
  it("should expand ~ to home dir", () => {
    const result = expandHome("~/test");
    expect(result).toMatch(/test$/);
  });

  it("should not expand non-home paths", () => {
    expect(expandHome("/usr/local")).toBe("/usr/local");
  });
});

describe("sleep", () => {
  it("should resolve after delay", async () => {
    const start = Date.now();
    await sleep(100);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });
});