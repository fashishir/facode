import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { toInputSchema } from "@/tools/types";

describe("toInputSchema conversion", () => {
  it("should convert ZodString to JSON Schema", () => {
    // Pass a property that uses the Zod type
    const result = toInputSchema(z.string());
    expect(result).toEqual({ type: "string" });
  });

  it("should convert ZodNumber to JSON Schema", () => {
    const result = toInputSchema(z.number());
    expect(result).toEqual({ type: "number" });
  });

  it("should convert ZodArray to JSON Schema", () => {
    const result = toInputSchema(z.array(z.string()));
    expect(result).toEqual({ type: "array", items: { type: "string" } });
  });

  it("should convert ZodOptional to JSON Schema", () => {
    const result = toInputSchema(z.string().optional());
    expect(result).toBeDefined();
  });

  it("should convert ZodEnum to JSON Schema", () => {
    const result = toInputSchema(z.enum(["a", "b", "c"]));
    expect(result).toEqual({ type: "string", enum: ["a", "b", "c"] });
  });

  it("should handle ZodBoolean", () => {
    const result = toInputSchema(z.boolean());
    expect(result).toEqual({ type: "boolean" });
  });
});