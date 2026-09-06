import { describe, expect, it } from "vitest";
import viteHubUI from "../src/vite.ts";

function pluginNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(pluginNames);
  if (value && typeof value === "object" && "name" in value) return [String(value.name)];
  return [];
}

describe("ViteHub UI Vite integration", () => {
  it("composes the Nuxt UI and Comark plugins", () => {
    const names = pluginNames(viteHubUI());
    expect(names.some((name) => name.includes("nuxt:ui"))).toBe(true);
    expect(names.some((name) => name.includes("comark"))).toBe(true);
  });

  it("allows Comark transforms to be disabled", () => {
    expect(pluginNames(viteHubUI({ comark: false })).some((name) => name.includes("comark"))).toBe(
      false,
    );
  });
});
