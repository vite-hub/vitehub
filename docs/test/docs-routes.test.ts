import { describe, expect, it } from "vitest";
import { resolveFrameworkSwitchPath } from "../modules/vitehub-docs/runtime/utils/docs-routes";

describe("resolveFrameworkSwitchPath", () => {
  it("rewrites docs paths to the requested framework", () => {
    expect(resolveFrameworkSwitchPath("/docs/nuxt/kv", "vite")).toBe("/docs/vite/kv");
  });

  it("falls back to the section overview when the target page is unsupported", () => {
    expect(resolveFrameworkSwitchPath("/docs/nuxt/kv/missing-page", "vite")).toBe("/docs/vite/kv");
  });

  it("keeps section landing pages when switching frameworks", () => {
    expect(resolveFrameworkSwitchPath("/docs/nuxt/providers", "vite")).toBe("/docs/vite/providers");
  });
});
