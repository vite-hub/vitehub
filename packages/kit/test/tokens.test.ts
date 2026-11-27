import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

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
  { mode: "system dark", kit: block(kit, ":root:not(.light, .dark, [data-theme])"), theme: block(theme, ":root:not(.light):not(.dark)") },
];

const renamed: Record<string, string> = {
  "--vh-media-scrim": "--media-scrim",
  "--vh-on-media": "--on-media",
  "--vh-shadow-dialog": "--shadow-dialog",
  "--vh-shadow-floating": "--shadow-popover",
};

const themeColors = Object.fromEntries([.../colors: \{([^}]+)\}/.exec(readFileSync(new URL("../../ui/src/theme.ts", import.meta.url), "utf8"))![1]!
  .matchAll(/(error|info|success|warning): "(\w+)"/g)].map(([, key, color]) => [key!, color!]));
const tailwind = readFileSync(createRequire(new URL("../../ui/package.json", import.meta.url)).resolve("tailwindcss/theme.css"), "utf8");
function shade(color: string, step: number): string {
  const value = new RegExp(`--color-${color}-${step}: ([^;]+);`).exec(tailwind)![1]!;
  return value.replace(/oklch\(([\d.]+)%/, (_, lightness: string) => `oklch(${Number((Number(lightness) / 100).toFixed(5))}`);
}

describe("the kit tokens", () => {
  it.each(modes)("supply every shared token read by the scoped family in $mode", ({ kit, theme }) => {
    const family = readFileSync(new URL("../src/styles/default.css", import.meta.url), "utf8");
    const names = [...new Set([...family.matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name!))]
      .filter(name => !/^--(?:ui|vh|font)-/.test(name));
    for (const name of names) {
      expect(theme.get(name) ?? modes[0]!.theme.get(name), name).toBe(kit.get(name) ?? modes[0]!.kit.get(name));
    }
  });

  it.each(modes)("have the values of theme.css in $mode", ({ kit, theme }) => {
    const expected = [...theme]
      .filter(([name]) => !/^--(?:ui|vh)-/.test(name) || name in renamed)
      .map(([name, value]) => [renamed[name] ?? name, value.replaceAll("var(--ui-border)", "var(--border)")]);
    expect(expected.length).toBeGreaterThan(7);
    expect(expected.map(([name]) => [name, kit.get(name!)])).toEqual(expected);
  });

  it.each(modes)("have the Nuxt UI steps of theme.css in $mode", ({ kit, theme }) => {
    const steps = [...kit.keys()].filter(name => /^--ui-(?:text|bg|border)/.test(name));
    expect(steps).toHaveLength(7);
    expect(steps.map(name => [name, kit.get(name)])).toEqual(steps.map(name => [name, theme.get(name)]));
  });

  it.each(modes)("have the status colors of theme.css and Nuxt UI in $mode", ({ mode, kit, theme }) => {
    expect(Object.keys(themeColors).sort()).toEqual(["error", "info", "success", "warning"]);
    for (const [key, color] of Object.entries(themeColors)) {
      const text = /var\(--ui-color-\w+-(\d+)\)/.exec(theme.get(`--vh-text-${key}`)!)![1]!;
      expect(kit.get(`--vh-text-${key}`), key).toBe(shade(color, Number(text)));
      expect(kit.get(`--ui-${key}`), key).toBe(shade(color, mode === "light" ? 500 : 400));
    }
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
