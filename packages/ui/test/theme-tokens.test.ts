import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const standalone = await readFile(new URL("../src/standalone/styles.css", import.meta.url), "utf8");
const overlay = await readFile(new URL("../../comments/src/overlay/styles.ts", import.meta.url), "utf8");
const block = /:where\(([^)]*)\) \{\n((?:\s+(?:\/\*.*\*\/|--vh-[\w-]+: .*;)\n)+)\}/.exec(stylesheet);

// A token resolved once at `:root` keeps the page's colors inside a surface that resets Nuxt UI's `--ui-*`, such as
// `<div class="dark">`. The parts read tokens that each of their elements resolves itself.
describe("the theme tokens", () => {
  it("resolves the tokens on the elements of the parts", () => {
    expect(block?.[1]).toBe(':root, [data-slot], [class^="vh-"], [class*=" vh-"]');
  });

  it("resolves each token from its override and then from Nuxt UI", () => {
    const declared = new Map([...block![2]!.matchAll(/(--vh-[\w-]+): (.*);/g)].map(([, name, value]) => [name!, value!]));
    expect(declared.size).toBeGreaterThan(10);
    for (const [name, value] of declared) expect(value, name).toMatch(new RegExp(`^var\\(${name.replace("--vh-", "--vh-ui-")}, `));
    // The parts read only the resolved tokens. A rule that read `--vh-ui-*` would miss the Nuxt UI value when it is unset.
    const outside = stylesheet.replace(block![0]!, "");
    expect([...outside.matchAll(/var\((--vh-ui-[\w-]+)/g)].map(([, name]) => name)).toEqual([]);
  });

  it("leaves the --vh-ui-* overrides to the app", () => {
    expect([...stylesheet.matchAll(/^\s*(--vh-ui-[\w-]+):/gm)].map(([, name]) => name)).toEqual([]);
  });

  it.each([["standalone", standalone], ["overlay", overlay]])("uses resolved tokens in the %s rules", (_name, rules) => {
    expect([...rules.matchAll(/var\((--vh-ui-[\w-]+)/g)].map(([, name]) => name)).toEqual([]);
  });
});
