import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const packageRuntime = new URL("../../packages/docs/runtime/", import.meta.url);

describe("docs color mode", () => {
  it("offers a manual color-mode control", async () => {
    const header = await readFile(new URL("app/components/AppHeader.vue", packageRuntime), "utf8");

    expect(header).toContain("<UColorModeButton");
  });

  it("defines browser schemes and a theme-owned dark palette", async () => {
    const styles = await readFile(new URL("theme/vercel.css", packageRuntime), "utf8");
    const lightRule = styles.match(/:root\.light \{(?<body>[^}]+)\}/)?.groups?.body;
    const darkRule = styles.match(/:root\.dark \{(?<body>[^}]+)\}/)?.groups?.body;

    expect(lightRule).toContain("color-scheme: light");
    expect(darkRule).toContain("color-scheme: dark");
    expect(darkRule).toContain("--ui-bg: var(--vh-ink)");
    expect(darkRule).toContain("--ui-bg-elevated: #18181b");
    expect(darkRule).toContain("--ui-border: #27272a");
    expect(darkRule).toContain("--ui-text: #e4e4e7");
    expect(darkRule).toContain("--ui-text-highlighted: var(--vh-paper)");
  });
});
