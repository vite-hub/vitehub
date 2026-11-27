import type { Plugin } from "vite";

/**
 * Removes the rules of `@vite-hub/ui/styles.css` that cannot match in a build: a selector that needs a `vh-*` class or
 * a `data-slot` value that no module of the build names. `used` holds every word of the build's code. A class or slot
 * inside parentheses, such as in `:not()` or `:is()`, keeps its selector. Other at-rules, such as `@keyframes`, stay.
 */
export function pruneStylesheet(css: string, used: ReadonlySet<string>): string {
  return pruneBlock(css, used);
}

/** The end of the string that starts at `start`, or of the comment, or `start` itself. */
function skipLiteral(css: string, start: number): number {
  const char = css[start];
  if (char === "\"" || char === "'") {
    let index = start + 1;
    while (index < css.length && css[index] !== char) index += css[index] === "\\" ? 2 : 1;
    return index + 1;
  }
  if (char === "/" && css[start + 1] === "*") {
    const end = css.indexOf("*/", start + 2);
    return end === -1 ? css.length : end + 2;
  }
  return start;
}

/** The index of the first `stops` character at this level, from `start`, or the end of the text. */
function scan(css: string, start: number, stops: string): number {
  let depth = 0;
  let index = start;
  while (index < css.length) {
    const skipped = skipLiteral(css, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const char = css[index]!;
    if (depth === 0 && stops.includes(char)) return index;
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    index++;
  }
  return index;
}

function pruneBlock(css: string, used: ReadonlySet<string>): string {
  let output = "";
  let index = 0;
  while (index < css.length) {
    const end = scan(css, index, "{;");
    const prelude = css.slice(index, end);
    if (end >= css.length || css[end] === ";") {
      output += css.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const close = scan(css, end + 1, "}");
    const body = css.slice(end + 1, close);
    index = close + 1;
    const head = prelude.trim();
    if (head.startsWith("@")) {
      // Rules inside `@media`, `@layer`, `@supports`, and `@container` are pruned. A block left empty goes too.
      if (/^@(?:media|layer|supports|container)\b/.test(head)) {
        const inner = pruneBlock(body, used);
        if (inner.trim()) output += `${prelude}{${inner}}`;
      }
      else output += `${prelude}{${body}}`;
      continue;
    }
    const selectors = splitSelectors(prelude).filter(selector => canMatch(selector, used));
    if (selectors.length) output += `${selectors.join(",")}{${body}}`;
  }
  return output;
}

function splitSelectors(prelude: string): string[] {
  const selectors: string[] = [];
  let index = 0;
  while (index <= prelude.length) {
    const end = scan(prelude, index, ",");
    selectors.push(prelude.slice(index, end));
    index = end + 1;
  }
  return selectors;
}

/** Whether every `vh-*` class and `data-slot` value outside parentheses is a word of the build. */
function canMatch(selector: string, used: ReadonlySet<string>): boolean {
  let top = "";
  let depth = 0;
  for (let index = 0; index < selector.length; index++) {
    const skipped = skipLiteral(selector, index);
    if (skipped !== index) {
      if (depth === 0) top += selector.slice(index, skipped);
      index = skipped - 1;
      continue;
    }
    const char = selector[index]!;
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0) top += char;
  }
  for (const [, name] of top.matchAll(/\.(vh-[\w-]+)/g)) if (!used.has(name!)) return false;
  for (const [, double, single, bare] of top.matchAll(/\[\s*data-slot\s*=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*\]/g)) {
    const value = double ?? single ?? bare;
    if (value !== undefined && !used.has(value)) return false;
  }
  return true;
}

const placeholder = "__VITEHUB_UI_STYLESHEET__";
const stylesheetId = /[\\/]ui[\\/]styles\.css\?inline$/;

/**
 * Prunes `@vite-hub/ui/styles.css?inline` in a build of a few parts, such as the comments overlay, to the rules those
 * parts can use. The stylesheet stays whole in apps, which import it as CSS and can render any part.
 */
export function standaloneStyles(): Plugin {
  const used = new Set<string>();
  let stylesheet: string | undefined;
  return {
    name: "vitehub-ui-standalone-styles",
    apply: "build",
    enforce: "post",
    transform(code, id) {
      if (stylesheetId.test(id)) {
        const literal = /^export default ("(?:[^"\\]|\\.)*")/.exec(code)?.[1];
        if (!literal) this.error(`The inline stylesheet ${id} has an unexpected shape.`);
        const value: unknown = JSON.parse(literal);
        if (typeof value !== "string") this.error(`The inline stylesheet ${id} has an unexpected shape.`);
        stylesheet = value;
        return { code: `export default ${JSON.stringify(placeholder)}`, map: null };
      }
      if (/\.css(?:\?|$)/.test(id)) return undefined;
      for (const [word] of code.matchAll(/[\w-]+/g)) used.add(word);
      return undefined;
    },
    renderChunk(code) {
      if (stylesheet === undefined || !code.includes(placeholder)) return undefined;
      const quote = code[code.indexOf(placeholder) - 1];
      const css = JSON.stringify(pruneStylesheet(stylesheet, used)).slice(1, -1);
      const text = quote === "`" ? css.replaceAll("`", "\\`").replaceAll("${", "\\${") : quote === "'" ? css.replaceAll("'", "\\'") : css;
      return { code: code.replaceAll(placeholder, () => text), map: null };
    },
  };
}
