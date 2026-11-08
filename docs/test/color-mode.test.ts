import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const packageRuntime = new URL("../../packages/docs/runtime/", import.meta.url);

describe("docs color mode", () => {
  it("offers a manual color-mode control", async () => {
    const header = await readFile(new URL("app/components/AppHeader.vue", packageRuntime), "utf8");

    expect(header).toContain("<UColorModeButton");
  });

  it("takes the browser schemes and the dark palette from the shared theme", async () => {
    const theme = await readFile(new URL("../../packages/ui/theme.css", import.meta.url), "utf8");
    const shell = await readFile(new URL("theme/shell.css", packageRuntime), "utf8");
    const darkRule = theme.match(/:root\.dark \{(?<body>[^}]+)\}/)?.groups?.body;

    expect(theme).toMatch(/:root \{[^}]*color-scheme: light/);
    expect(darkRule).toContain("color-scheme: dark");
    expect(darkRule).toContain("--ui-bg:");
    expect(darkRule).toContain("--ui-text-highlighted:");
    // The docs shell lays the page out and leaves every color to the theme.
    expect(shell).not.toMatch(/--ui-(bg|text|border)[\w-]*:/);
  });
});
