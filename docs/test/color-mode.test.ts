import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("docs color mode", () => {
  it("offers a manual color-mode control", async () => {
    const header = await readFile(
      new URL("../app/components/AppHeader.vue", import.meta.url),
      "utf8",
    );

    expect(header).toContain("<UColorModeButton />");
  });

  it("defines browser schemes and a ViteHub-owned dark palette", async () => {
    const styles = await readFile(
      new URL("../app/assets/main.css", import.meta.url),
      "utf8",
    );
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
