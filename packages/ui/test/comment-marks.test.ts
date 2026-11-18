import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const marks = await readFile(new URL("../comment-marks.css", import.meta.url), "utf8");
const built = await readFile(new URL("../dist/comment-marks.css", import.meta.url), "utf8");
const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const overlay = await readFile(new URL("../../comments/src/overlay/styles.ts", import.meta.url), "utf8");
const packageJson: { exports: Record<string, unknown>; sideEffects: string[] } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// Drop's page frame and the ViteHub pill load this file without Vue, so its data attributes and highlight names are a contract.
describe("@vite-hub/ui/comment-marks.css", () => {
  it("is a package export that ships in dist", () => {
    expect(packageJson.exports["./comment-marks.css"]).toBe("./dist/comment-marks.css");
    expect(packageJson.sideEffects).toContain("./dist/comment-marks.css");
    expect(built).toBe(marks);
  });

  it("styles the marks by data attribute", () => {
    for (const selector of [
      '[data-slot="comment-mark-pin"]',
      '[data-shape="round"]',
      '[data-slot="comment-mark-area"][data-status="resolved"]',
      '[data-slot="comment-mark-area"][data-active="true"]',
      '[data-slot="comment-mark-area"][data-draft="true"]',
      '[data-slot="comment-mark-handle"]',
      '[data-corner^="top"]',
      '[data-leaving="true"]',
    ]) expect(marks, selector).toContain(selector);
    expect(marks).toContain("--vh-comment-pin-size: var(--vh-ui-comment-pin-size, 28px);");
  });

  it("leaves the pop-out of a mark to the motion layer, and adds its zoom with a transform", () => {
    // The leave effect of @vite-hub/ui/motion folds a copy of a leaving mark away, so the stylesheet has no animation.
    expect(marks).not.toMatch(/@keyframes|animation:/);
    expect(marks).toMatch(/\[data-leaving="true"\] > \* \{\s*pointer-events: none;/);
    // The press of the motion layer writes `scale`, so the zoom and the larger active pin are a `transform`.
    expect(marks).toContain("transform: scale(var(--vh-comment-zoom, 1));");
    expect(marks).not.toMatch(/:hover[^{]*\{[^}]*scale/);
  });

  it("draws a saved area as a neutral line, and keeps the comment blue for the area being drawn", () => {
    const rule = (selector: string) => new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(marks)?.[1];
    const saved = rule(':is([data-slot="comment-mark-area"], [data-slot="comment-layer-area"])');
    expect(saved).toContain("solid color-mix(in oklab, var(--vh-comment-ink) 22%, transparent);");
    const active = rule('[data-slot="comment-mark-area"][data-active="true"]');
    expect(active).toContain("border-color: color-mix(in oklab, var(--vh-comment-ink) 45%, transparent);");
    expect(active).not.toContain("background");
    expect(`${saved}${active}`).not.toContain("--vh-comment-mark");
    expect(rule(':is([data-slot="comment-mark-area"][data-draft="true"], [data-slot="comment-layer-area"])')).toContain("solid var(--vh-comment-mark);");
  });

  it("colors the four highlights of commented text", () => {
    const names = [...marks.matchAll(/::highlight\(([\w-]+)\)/g)].map(([, name]) => name);
    expect(names).toEqual(["vh-comment", "vh-comment-resolved", "vh-comment-active", "vh-comment-draft"]);
  });

  it("writes colors only as the theme defaults", () => {
    const rules = marks.replace(/:root,\n:host \{[^}]*\}/, "").replace(/:root\.dark,[^{]*\{[^}]*\}/, "").replace(/@media \(prefers-color-scheme: dark\) \{[^}]*\}\s*\}/, "");
    expect(rules).not.toMatch(/oklch\(|rgb\(|#[0-9a-f]{3,8}\b/i);
  });

  it("is the one source of the pin and area look", () => {
    // styles.css takes the marks into its components layer, so a utility class on CommentPin still wins.
    expect(stylesheet).toContain('@import "./comment-marks.css" layer(components);');
    for (const source of [stylesheet, overlay]) {
      expect(source).not.toMatch(/\[data-slot="comment-pin"\]\[data-status="resolved"\]/);
      expect(source).not.toMatch(/\[data-slot="comment-layer-area"\] \{[^}]*border:/);
      expect(source).not.toContain("::highlight(");
    }
  });
});
