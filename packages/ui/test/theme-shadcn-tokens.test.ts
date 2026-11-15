import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const theme = await readFile(new URL("../theme.css", import.meta.url), "utf8");

function block(selector: string): Map<string, string> {
  const start = theme.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const body = theme.slice(start, theme.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
}

const light = block(":root");
const dark = block(":root.dark");
const systemDark = block(":root:not(.light):not(.dark)");
const shadcn = (tokens: Map<string, string>) => [...tokens.keys()].filter(name => !/^--(?:ui|vh)-/.test(name)).sort();

// Apps set these names after theme.css to change the Nuxt UI and ViteHub tokens. The docs list them, and
// @vite-hub/docs keeps an app's own values for them (packages/docs/src/theme-css.ts).
describe("the shadcn/ui tokens of theme.css", () => {
  it("sets the documented names, and the radius once", () => {
    expect(shadcn(light)).toEqual(["--background", "--border", "--foreground", "--muted", "--muted-foreground", "--popover", "--primary", "--radius", "--ring"]);
    expect(shadcn(dark)).toEqual(shadcn(light).filter(name => name !== "--radius"));
  });

  it("gives system dark mode the same tokens as the dark class", () => {
    expect(systemDark).toEqual(dark);
  });

  it.each([["light", light], ["dark", dark]] as const)("feeds every name into a token that reads it in the same %s block", (_mode, tokens) => {
    const reads = [...tokens.values()].flatMap(value => [...value.matchAll(/var\((--[\w-]+)\)/g)].map(([, name]) => name!));
    for (const name of shadcn(tokens)) expect(reads, name).toContain(name);
    expect(reads.filter(name => !/^--(?:ui|vh)-/.test(name) && !tokens.has(name))).toEqual([]);
  });

  it("reads each name the same way in light and dark", () => {
    const mapping = (tokens: Map<string, string>) => [...tokens].filter(([, value]) => /^var\(--(?!ui-|vh-)/.test(value));
    expect(mapping(dark)).toEqual(mapping(light).filter(([name]) => name !== "--ui-radius"));
  });
});
