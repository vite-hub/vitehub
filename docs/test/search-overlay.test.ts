import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("docs search overlay", () => {
  it("anchors expanding desktop results below the viewport top", async () => {
    const css = await readFile(new URL("../app/assets/main.css", import.meta.url), "utf8");
    const desktopRule = css.match(/\.vitehub-content-search-modal \{(?<body>[^}]+)\}/)?.groups
      ?.body;

    expect(desktopRule).toContain("top: 248px !important;");
    expect(desktopRule).toContain("translate: -50% 0 !important;");
  });

  it("keeps the centered position for the phone sheet", async () => {
    const css = await readFile(new URL("../app/assets/main.css", import.meta.url), "utf8");
    const phoneRule = css.match(
      /@media \(max-width: 640px\) \{\s*\.vitehub-content-search-modal \{(?<body>[^}]+)\}/,
    )?.groups?.body;

    // The minifier merged a phone `translate: none` into `transform`, so the base translate moved the modal off screen.
    expect(phoneRule).toContain("top: 0 !important;");
    expect(phoneRule).not.toMatch(/\b(left|right|translate|transform)\s*:/);
  });
});
