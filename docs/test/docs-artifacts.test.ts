import { describe, expect, it } from "vitest";
import { filterFwBlocksForFramework, rewriteFrameworkDocLinks } from "../modules/vitehub-docs/artifacts";

describe("filterFwBlocksForFramework", () => {
  it("keeps only matching explicit id blocks", () => {
    const source = [
      "# Getting started",
      "",
      "::fw{id=\"vite:dev vite:build\"}",
      "Vite setup",
      "::",
      "",
      "::fw{id=\"nitro:dev nitro:build\"}",
      "Nitro setup",
      "::",
      "",
      "::fw{id=\"nuxt:dev nuxt:build\"}",
      "Nuxt app",
      "::",
    ].join("\n");

    const filtered = filterFwBlocksForFramework(source, "nitro");

    expect(filtered).toContain("# Getting started");
    expect(filtered).toContain("Nitro setup");
    expect(filtered).not.toContain("::fw");
    expect(filtered).not.toContain("Vite setup");
    expect(filtered).not.toContain("Nuxt app");
  });

  it("keeps matching shorthand framework blocks", () => {
    const source = [
      "::fw{nitro nuxt}",
      "Server platforms",
      "::",
      "",
      "::fw{vite}",
      "Vite only",
      "::",
    ].join("\n");

    expect(filterFwBlocksForFramework(source, "nitro")).toContain("Server platforms");
    expect(filterFwBlocksForFramework(source, "nitro")).not.toContain("Vite only");
    expect(filterFwBlocksForFramework(source, "vite")).toContain("Vite only");
    expect(filterFwBlocksForFramework(source, "vite")).not.toContain("Server platforms");
  });

  it("preserves frontmatter and non-fw markdown", () => {
    const source = [
      "---",
      "title: Providers",
      "---",
      "",
      "# Providers",
      "",
      "Regular paragraph.",
    ].join("\n");

    expect(filterFwBlocksForFramework(source, "nuxt")).toBe(source);
  });

  it("preserves malformed fw blocks", () => {
    const source = [
      "# Broken",
      "",
      "::fw{nitro}",
      "Unclosed body",
    ].join("\n");

    expect(filterFwBlocksForFramework(source, "nitro")).toBe(source);
  });
});

describe("rewriteFrameworkDocLinks", () => {
  it("rewrites package docs links to absolute framework routes", () => {
    const source = [
      "Start with [Quickstart](./quickstart).",
      "",
      ":::u-page-card",
      "---",
      "to: ./providers/cloudflare",
      "---",
      ":::",
    ].join("\n");

    expect(rewriteFrameworkDocLinks(source, "vite", "kv", "index.md")).toContain("[Quickstart](/docs/vite/kv/quickstart)");
    expect(rewriteFrameworkDocLinks(source, "vite", "kv", "index.md")).toContain("to: /docs/vite/kv/providers/cloudflare");
  });

  it("rewrites nested index links without leaving index in the route", () => {
    const source = [
      "- [Overview](../index)",
      "- [Usage](../usage#methods)",
    ].join("\n");

    const rewritten = rewriteFrameworkDocLinks(source, "nuxt", "kv", "providers/cloudflare.md");

    expect(rewritten).toContain("[Overview](/docs/nuxt/kv)");
    expect(rewritten).toContain("[Usage](/docs/nuxt/kv/usage#methods)");
  });

  it("rewrites cross-section links from generated route locations", () => {
    const source = [
      "- [KV overview](../kv)",
      "- [Cloudflare](../kv/providers/cloudflare)",
    ].join("\n");

    const rewritten = rewriteFrameworkDocLinks(source, "nitro", "providers", "cloudflare.md");

    expect(rewritten).toContain("[KV overview](/docs/nitro/kv)");
    expect(rewritten).toContain("[Cloudflare](/docs/nitro/kv/providers/cloudflare)");
  });

  it("leaves external, absolute, hash, and image links unchanged", () => {
    const source = [
      "[External](https://example.com)",
      "[Absolute](/docs/nuxt/kv)",
      "[Hash](#usage)",
      "![Image](./diagram.png)",
    ].join("\n");

    expect(rewriteFrameworkDocLinks(source, "vite", "kv", "usage.md")).toBe(source);
  });
});
