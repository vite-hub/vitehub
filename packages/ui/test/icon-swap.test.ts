import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const swap = await readFile(new URL("../icon-swap.css", import.meta.url), "utf8");
const built = await readFile(new URL("../dist/icon-swap.css", import.meta.url), "utf8");
const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const packageJson: { exports: Record<string, unknown>; sideEffects: string[] } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// Drop's page frame inlines this file without Vue, so its data attributes are a contract.
describe("@vite-hub/ui/icon-swap.css", () => {
  it("is a package export that ships in dist, and styles.css leaves it out for CopyButton's swapIcon", () => {
    expect(packageJson.exports["./icon-swap.css"]).toBe("./dist/icon-swap.css");
    expect(packageJson.sideEffects).toContain("./dist/icon-swap.css");
    expect(built).toBe(swap);
    expect(stylesheet).not.toContain("icon-swap.css");
  });

  it("stacks the two icons in one grid cell and swaps them on data-copied", () => {
    expect(swap).toMatch(/\[data-slot="copy-button-icon"\] \{\s*display: grid;/);
    expect(swap).toMatch(/\[data-slot="copy-button-icon"\] > \* \{\s*display: flex;\s*grid-area: 1 \/ 1;/);
    for (const selector of [
      '[data-slot="copy-button-icon"] > [data-icon="check"]',
      '[data-copied] [data-slot="copy-button-icon"] > [data-icon="copy"]',
      '[data-slot="copy-button-icon"] > [data-icon="copy"]',
      '[data-copied] [data-slot="copy-button-icon"] > [data-icon="check"]',
    ]) expect(swap, selector).toContain(selector);
  });

  it("cross-fades with transitions of opacity, scale, and filter only, and none under reduced motion", () => {
    expect(swap).toContain("transition-property: opacity, scale, filter;");
    expect(swap).toContain("transition-timing-function: cubic-bezier(0.23, 1, 0.32, 1);");
    expect(swap).toContain("transition-duration: 300ms;");
    expect(swap).toContain("transition-duration: 200ms;");
    expect(swap).not.toContain("@keyframes");
    expect(swap).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\[data-slot="copy-button-icon"\] > \* \{\s*transition: none;/);
  });
});
