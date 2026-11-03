import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const themeUrl = new URL("../../packages/docs/runtime/theme/vercel.css", import.meta.url);

describe("docs search overlay", () => {
  it("anchors expanding desktop results below the viewport top", async () => {
    const css = await readFile(themeUrl, "utf8");
    const desktopRule = css.match(/\.vh-docs-search-modal \{(?<body>[^}]+)\}/)?.groups?.body;

    expect(desktopRule).toContain("top: 248px !important;");
    expect(desktopRule).toContain("translate: -50% 0 !important;");
  });

  it("keeps the centered position for the phone sheet", async () => {
    const css = await readFile(themeUrl, "utf8");
    const phoneRule = css.match(/@media \(max-width: 640px\) \{\s*\.vh-docs-search-modal \{(?<body>[^}]+)\}/)?.groups?.body;

    // The minifier merged a phone `translate: none` into `transform`, so the base translate moved the modal off screen.
    expect(phoneRule).toContain("top: 0 !important;");
    expect(phoneRule).not.toMatch(/\b(left|right|translate|transform)\s*:/);
  });
});
