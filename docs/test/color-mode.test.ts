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

  it("defines ViteHub-owned light and dark browser palettes", async () => {
    const styles = await readFile(
      new URL("../app/assets/main.css", import.meta.url),
      "utf8",
    );

    expect(styles).toContain(":root.light");
    expect(styles).toContain("color-scheme: light");
    expect(styles).toContain(":root.dark");
    expect(styles).toContain("color-scheme: dark");
    expect(styles).toContain("--ui-bg: var(--vh-ink)");
    expect(styles).toContain("--ui-bg-elevated: #18181b");
    expect(styles).toContain("--ui-border: #27272a");
    expect(styles).toContain("--ui-text: #e4e4e7");
    expect(styles).toContain("--ui-text-highlighted: var(--vh-paper)");
  });
});
