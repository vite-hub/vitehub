import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

  it("switches blob docs between supported frameworks", () => {
    expect(resolveFrameworkSwitchPath("/docs/vite/blob", "nitro")).toBe("/docs/nitro/blob");
    expect(resolveFrameworkSwitchPath("/docs/nitro/blob/quickstart", "vite")).toBe("/docs/vite/blob/quickstart");
  });

  it("falls back to getting started when the target framework does not support the section", () => {
    expect(resolveFrameworkSwitchPath("/docs/nitro/queue", "nuxt")).toBe("/docs/nuxt/getting-started");
    expect(resolveFrameworkSwitchPath("/docs/vite/queue/usage", "nuxt")).toBe("/docs/nuxt/getting-started");
    expect(resolveFrameworkSwitchPath("/docs/nitro/blob", "nuxt")).toBe("/docs/nuxt/getting-started");
  });

  it("falls back from unsupported blog framework switches", () => {
    expect(resolveFrameworkSwitchPath("/blogs/vite/build-ai-chatbot", "nuxt")).toBe("/blogs/vite");
    expect(resolveFrameworkSwitchPath("/blogs/vite/build-ai-chatbot", "nitro")).toBe("/blogs/nitro/build-ai-chatbot");
  });

  it("does not redirect unsupported Nuxt tutorials to missing blog routes", async () => {
    const middleware = await readFile(resolve(import.meta.dirname, "../server/middleware/blogs-redirect.ts"), "utf8");

    expect(middleware).toContain("(vite|nitro)");
    expect(middleware).not.toContain("(vite|nitro|nuxt)");
  });
});
