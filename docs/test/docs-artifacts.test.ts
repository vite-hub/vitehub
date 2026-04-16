import { describe, expect, it } from "vitest";
import { filterFwBlocksForFramework } from "../modules/vitehub-docs/artifacts";

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
