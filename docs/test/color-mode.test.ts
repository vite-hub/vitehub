import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const packageRuntime = new URL("../../packages/docs/runtime/", import.meta.url);

describe("docs color mode", () => {
  it("offers a manual color-mode control", async () => {
    const header = await readFile(new URL("app/components/AppHeader.vue", packageRuntime), "utf8");

    expect(header).toContain("<UColorModeButton");
  });

  it("defines browser schemes and the design's dark palette", async () => {
    const styles = await readFile(new URL("theme/design.css", packageRuntime), "utf8");
    const lightRule = styles.match(/:root:where\(\.vh-docs\)\.light \{(?<body>[^}]+)\}/)?.groups?.body;
    const darkRule = styles.match(/:root:where\(\.vh-docs\)\.dark \{(?<body>[^}]+)\}/)?.groups?.body;

    expect(lightRule).toContain("color-scheme: light");
    expect(darkRule).toContain("color-scheme: dark");
    expect(darkRule).toContain("--ui-bg: oklch(0.145 0 0)");
    expect(darkRule).toContain("--ui-bg-elevated: oklch(0.22 0 0)");
    expect(darkRule).toContain("--ui-border: oklch(0.26 0 0)");
    expect(darkRule).toContain("--ui-text: oklch(0.87 0 0)");
    expect(darkRule).toContain("--ui-text-highlighted: oklch(0.96 0 0)");
  });
});
