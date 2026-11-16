// Builds the packed style family. The kit build and the style check both run it, so the check sees what ships.
import postcss from "postcss";
import type { AtRule, Container, Rule } from "postcss";
import selectorParser from "postcss-selector-parser";

const webCssImport = '@import "@ui-sdk/core/web.css";';

/**
 * Returns `default.css` with web.css in it, not an import of it. The workspace patches web.css
 * (`patches/@ui-sdk__core@*.patch`), and an app that installs the kit gets the unpatched file from npm.
 */
export function inlineWebCss(defaultCss: string, webCss: string): string {
  if (!defaultCss.includes(webCssImport)) throw new Error(`default.css has no ${webCssImport}`);
  const notice = "/* @ui-sdk/core/web.css (Apache-2.0), with the patch in vite-hub/vitehub patches/. */";
  return defaultCss.replace(webCssImport, () => `${notice}\n${webCss.trim()}`);
}

/** The class of a scope root. The parts of the scoped family style only elements inside an element with this class. */
export const scopeClass = "ui-sdk";

const root = `.${scopeClass}`;
const anyRoot = `:where(${root})`;

// At-rules that hold rules for elements. `@keyframes` holds keyframes, and `@font-face` and `@property` hold no rules,
// so they stay global. Any other at-rule with rules in it stops the build until this file knows what it means.
const groupingAtRules = new Set(["container", "layer", "media", "starting-style", "supports"]);
const globalAtRules = new Set(["-webkit-keyframes", "font-face", "keyframes", "property"]);

/**
 * A node of postcss-selector-parser, read through the fields this file uses. The parser's own `Selector` type refers to
 * itself, and TypeScript 6 stops on it (TS5115), so the nodes are read through this shape.
 */
export interface SelectorPart {
  type: string;
  value: string;
  attribute?: string;
  nodes?: SelectorPart[];
  toString(): string;
}

/** The complex selectors of a selector list, such as `a, .b > c`, each as its compounds and combinators. */
export function parseSelectors(selectors: string): SelectorPart[] {
  return selectorParser().astSync(selectors).nodes as unknown as SelectorPart[];
}

const rootTags = new Set(["body", "html"]);
const rootPseudos = new Set([":host", ":root"]);

/** `:root`, `:host`, `html`, `body`, and `:where()` or `:is()` of them only: the page root, which the scope root stands in for. */
function isPageRoot(node: SelectorPart): boolean {
  if (node.type === "tag") return rootTags.has(node.value.toLowerCase());
  if (node.type !== "pseudo") return false;
  const selectors = node.nodes ?? [];
  if (rootPseudos.has(node.value) && selectors.length === 0) return true;
  return (
    (node.value === ":where" || node.value === ":is") &&
    selectors.length > 0 &&
    selectors.every((selector) => selector.nodes?.length === 1 && isPageRoot(selector.nodes[0]!))
  );
}

/** `.dark`, `.light`, and `[data-theme]`: a theme switch, set on the page root or on any element around a part. */
function isThemeMarker(node: SelectorPart): boolean {
  if (node.type === "class") return node.value === "dark" || node.value === "light";
  return node.type === "attribute" && node.attribute === "data-theme";
}

/**
 * Moves one complex selector under the scope root, with the same specificity:
 * - a selector for a part, such as `[data-slot="button"]` or `a`, gets `:where(.ui-sdk) ` before it;
 * - the page root (`:root`, `html`) becomes the scope root;
 * - a theme marker (`.dark`, `[data-theme="dark"]`) matches inside the scope, on the scope root, or around it.
 */
function scopeSelector(selector: SelectorPart, where: string): string[] {
  const nodes = selector.nodes ?? [];
  const combinator = nodes.findIndex((node) => node.type === "combinator");
  const first = combinator === -1 ? nodes : nodes.slice(0, combinator);
  const rest = combinator === -1 ? "" : nodes.slice(combinator).join("").trimEnd();
  const text = selector.toString().trim();

  if (nodes.some((node) => node.type === "nesting")) {
    throw new Error(`${where}: a top-level rule with & has no parent to scope: ${text}`);
  }
  for (const node of nodes.slice(first.length)) {
    if (isPageRoot(node)) throw new Error(`${where}: the page root is not the first part of ${text}`);
  }

  const pageRoots = first.filter(isPageRoot);
  const markers = first.filter(isThemeMarker);
  if (pageRoots.length === 0 && markers.length === 0) return [`${anyRoot} ${text}`];

  if (pageRoots.length + markers.length !== first.length || pageRoots.length > 1) {
    throw new Error(`${where}: the page root or a theme marker shares a compound with other selectors: ${text}`);
  }

  // `:root` and `:is(:root)` weigh one class, like `.ui-sdk`. `html` and `:where(:root)` weigh less, so they keep nothing.
  const pageRoot = pageRoots[0];
  const scopeRoot = pageRoot && (pageRoot.type === "tag" || pageRoot.value === ":where") ? anyRoot : root;
  if (markers.length === 0) return [`${scopeRoot}${rest}`];

  const marker = markers.map((node) => node.toString().trim()).join("");
  const scoped = [
    // The marker is on the scope root, or on an element around it, such as `<html class="dark">`.
    `${root}:where(${marker})${rest}`,
    `:where(${marker}) ${root}${rest}`,
  ];
  // Without the page root, the marker also matches an element inside the scope.
  if (!pageRoot) scoped.unshift(`${anyRoot} ${text}`);
  return scoped;
}

function scopeRule(rule: Rule, where: string): void {
  const selectors = parseSelectors(rule.selector).flatMap((selector) => scopeSelector(selector, where));
  const indent = (rule.raws.before ?? "").split("\n").pop() ?? "";
  rule.selector = selectors.join(`,\n${indent}`);
}

function isNested(rule: Rule): boolean {
  for (let parent: Container | undefined = rule.parent; parent; parent = parent.parent as Container | undefined) {
    if (parent.type === "rule") return true;
    if (parent.type === "atrule") {
      const name = (parent as AtRule).name.toLowerCase();
      if (globalAtRules.has(name)) return true;
      if (!groupingAtRules.has(name)) throw new Error(`@${name} holds rules, and scripts/styles.ts does not know how to scope it`);
    }
  }
  return false;
}

/**
 * Builds `default.scoped.css`: an app that still renders Nuxt UI loads it and moves its pages to ui-sdk one by one.
 * Returns `css` with every rule under a scope root (`.ui-sdk`), with the same specificity, so that the cascade between
 * the family's own rules does not change. Nested rules follow their parent. `@keyframes`, `@property`, and `@font-face`
 * stay global, and `@media`, `@supports`, `@container`, and `@layer` keep their rules in them.
 */
export function scopeStyles(css: string, from = "default.css"): string {
  const ast = postcss.parse(css, { from });
  ast.walkRules((rule) => {
    if (isNested(rule)) return;
    scopeRule(rule, `${from}:${rule.source?.start?.line ?? "?"}`);
  });
  // The header of default.css says to load it only without Nuxt UI. The scoped header says how to load it next to Nuxt UI.
  if (ast.first?.type === "comment") ast.first.remove();
  return `${scopedHeader}\n${ast.toString().trim()}\n\n${colorScheme}`;
}

const scopedHeader = `/*
 * The default style family of ViteHub UI under a scope root, for an app that still renders Nuxt UI. It is default.css
 * with every rule under \`:where(.${scopeClass})\`, so it styles only the elements inside an element with the \`${scopeClass}\`
 * class, with the same specificity. The scope root takes the rules of \`:root\` and \`html\`. A scope root holds no Nuxt UI
 * component. See "Next to Nuxt UI" in the README of @vite-hub/kit.
 *
 *   @layer theme, base, ui-sdk, components, utilities;
 *   @import "@vite-hub/kit/styles/tokens.css";
 *   @import "@vite-hub/kit/styles/default.scoped.css";
 */
`;

// The page owns \`color-scheme\`: \`tokens.css\` and \`@vite-hub/ui/theme.css\` set it on \`:root\` and on \`.dark\`, where it
// beats web.css's \`light dark\`. On the scope root nothing beats web.css, so the root takes the page's value back.
const colorScheme = `/* The scope root takes the page's color scheme, as the page root does in default.css. */
${anyRoot} {
  color-scheme: inherit;
}
`;
