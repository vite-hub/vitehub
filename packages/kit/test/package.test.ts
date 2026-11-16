import { readFileSync } from "node:fs";
import postcss from "postcss";
import type { AtRule, Container, Root } from "postcss";
import { describe, expect, it } from "vitest";

import { parseSelectors } from "../scripts/styles.ts";
import type { SelectorPart } from "../scripts/styles.ts";

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js";
import { kitEntries, ownEntries, uiSdkEntries } from "./entries.ts";

const manifest: {
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
} = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

describe("@vite-hub/kit package contract", () => {
  it("installs ui-sdk and nothing else", () => {
    // The package exists so that headless parts do not install the dependencies of @vite-hub/ui (CodeMirror, xterm, Shiki).
    expect(manifest.dependencies).toEqual({ "@ui-sdk/core": "0.1.0-beta.5", "@ui-sdk/vue": "0.1.0-beta.5" });
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual(["@nuxt/kit", "@nuxt/schema", "nuxt", "vue"]);
  });

  it("has 7 entries or fewer", () => {
    // `./styles/default.scoped.css` goes when the Console has no Nuxt UI left, and the kit is back to 6.
    expect(Object.keys(manifest.exports).length).toBeLessThanOrEqual(7);
  });

  it("has one entry for each part it adds, and none that ui-sdk has", () => {
    expect(kitEntries.toSorted()).toEqual(ownEntries.toSorted());
    expect(kitEntries.filter((entry) => uiSdkEntries.includes(entry))).toEqual([]);
  });

  it("ships the patched web.css inside default.css, not an import of the npm file", () => {
    const packed = readFileSync(new URL("../dist/styles/default.css", import.meta.url), "utf8");
    expect(packed).not.toContain('@import "@ui-sdk');
    // Rules that only the workspace patch of @ui-sdk/core adds.
    expect(packed).toContain('[data-slot="input-group"]');
    expect(packed).toContain("--ui-radius-popup");
  });

  it("ships default.scoped.css with every rule on the scope root or inside it", () => {
    const packed = (name: string) => postcss.parse(readFileSync(new URL(`../dist/styles/${name}`, import.meta.url), "utf8"));
    const scoped = packed("default.scoped.css");
    const atRules = new Set<string>();
    const outside: string[] = [];
    scoped.walkAtRules((atRule) => {
      atRules.add(atRule.name);
    });
    scoped.walkRules((rule) => {
      for (let parent: Container | undefined = rule.parent; parent; parent = parent.parent as Container | undefined) {
        if (parent.type === "rule" || (parent.type === "atrule" && (parent as AtRule).name === "keyframes")) return;
      }
      for (const selector of parseSelectors(rule.selector)) if (!onScopeRoot(selector)) outside.push(selector.toString().trim());
    });
    expect(outside).toEqual([]);
    expect([...atRules].filter((name) => !["container", "font-face", "keyframes", "layer", "media", "property", "supports"].includes(name))).toEqual([]);
    // The same declarations as default.css, and the one that gives the scope root the page's color-scheme.
    const declarations = (root: Root) => {
      let count = 0;
      root.walkDecls(() => {
        count++;
      });
      return count;
    };
    expect(declarations(scoped)).toBe(declarations(packed("default.css")) + 1);
  });

  it("loads each entry from the built package", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/kit", [...kitEntries, "nuxt"]);
  }, 60_000);
});

/** The selector matches the scope root or an element inside it: a compound with `.ui-sdk`, then only `>` or descendant combinators. */
function onScopeRoot(selector: SelectorPart): boolean {
  let scoped = false;
  for (const node of selector.nodes ?? []) {
    if (node.type === "combinator") {
      if (scoped && node.value.trim() !== "" && node.value.trim() !== ">") return false;
      continue;
    }
    const scopeClass = (node.type === "class" && node.value === "ui-sdk") || (node.type === "pseudo" && node.value === ":where" && node.toString().trim() === ":where(.ui-sdk)");
    if (scopeClass) scoped = true;
  }
  return scoped;
}
