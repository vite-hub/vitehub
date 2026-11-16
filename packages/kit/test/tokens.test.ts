import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The kit tokens take the values of `@vite-hub/ui/theme.css`, the tokens that the Console and the docs use today. The
// packages do not depend on each other, so this check reads both source files and fails when they disagree.
const kit = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../../ui/theme.css", import.meta.url), "utf8");

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
}

const modes = [
  { mode: "light", kit: block(kit, ":root"), theme: block(theme, ":root") },
  { mode: "dark", kit: block(kit, ':is(.dark, [data-theme="dark"])'), theme: block(theme, ":root.dark") },
  { mode: "system dark", kit: block(kit, ":root:not(.light, [data-theme])"), theme: block(theme, ":root:not(.light):not(.dark)") },
];

// theme.css names a few kit tokens with its `--vh-` prefix, and reads `--ui-border`, which is `var(--border)`.
const renamed: Record<string, string> = {
  "--vh-media-scrim": "--media-scrim",
  "--vh-on-media": "--on-media",
  "--vh-shadow-dialog": "--shadow-dialog",
  "--vh-shadow-floating": "--shadow-popover",
};

describe("the kit tokens", () => {
  it.each(modes)("have the values of theme.css in $mode", ({ kit, theme }) => {
    const expected = [...theme]
      .filter(([name]) => !/^--(?:ui|vh)-/.test(name) || name in renamed)
      .map(([name, value]) => [renamed[name] ?? name, value.replaceAll("var(--ui-border)", "var(--border)")]);
    expect(expected.length).toBeGreaterThan(7);
    expect(expected.map(([name]) => [name, kit.get(name!)])).toEqual(expected);
  });

  it("have the fonts of theme.css", () => {
    const fonts = block(theme, "@theme");
    const light = block(kit, ":root");
    expect(light.get("--font-sans")).toBe(fonts.get("--font-sans"));
    expect(light.get("--font-mono")).toBe(fonts.get("--font-mono"));
  });

  it("give system dark mode the same tokens as the dark class", () => {
    expect(modes[2]!.kit).toEqual(modes[1]!.kit);
  });
});
