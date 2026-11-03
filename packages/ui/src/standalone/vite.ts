import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..");
const virtualIcons = "virtual:vitehub-ui-icons";

// The Phosphor icons that the comment parts, the Prompt Input, and the image preview ask for by class name. The two
// Lucide icons of the image preview get their Phosphor twins.
const icons: Record<string, string> = {
  "i-lucide-external-link": "arrow-square-out",
  "i-lucide-x": "x-light",
  ...Object.fromEntries([
    "arrow-clockwise",
    "arrow-counter-clockwise",
    "arrow-left",
    "arrow-up",
    "chat-circle",
    "check",
    "file-light",
    "list-bullets",
    "note-pencil",
    "pencil-simple-light",
    "plus",
    "stop-fill",
    "trash-light",
    "x-light",
  ].map(name => [`i-ph-${name}`, name])),
};

// The icons are drawn from elements, never from markup, so a flat list of shapes is all that they need.
function shapes(name: string, body: string): Array<[string, Record<string, string>]> {
  const found: Array<[string, Record<string, string>]> = [];
  for (const [, tag, attributes] of body.matchAll(/<(\w+)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)) {
    if (tag === "g" || tag === "svg") throw new TypeError(`The Phosphor icon "${name}" nests elements, which the stand-in UIcon does not draw.`);
    found.push([tag!, Object.fromEntries([...attributes!.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]))]);
  }
  if (!found.length || body.replaceAll(/<\w+(?:\s+[\w:-]+="[^"]*")*\s*\/?>/g, "").trim()) throw new TypeError(`The Phosphor icon "${name}" has a body that the stand-in UIcon cannot draw: ${body}`);
  return found;
}

/**
 * Lets the styled parts run without Nuxt UI, such as in an overlay that a page loads into a shadow root. Pair it with
 * the stand-ins of `standalone/nuxt-ui.ts`. It replaces the Markdown part with `standalone/markdown.ts`, which has no
 * parser, highlighter, or KaTeX; it gives `UIcon` its icons as shapes; and it drops the Chat and KaTeX imports of the
 * stylesheet, which the comment parts do not use.
 */
export function standaloneUI(): Plugin {
  return {
    name: "vitehub-ui-standalone",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === virtualIcons) return `\0${virtualIcons}`;
      if (importer?.startsWith(source) && !importer.startsWith(here) && /(^|\/)markdown\.ts$/.test(id)) return resolve(here, "markdown.ts");
      return undefined;
    },
    load(id) {
      if (id !== `\0${virtualIcons}`) return undefined;
      const require = createRequire(import.meta.url);
      const set = JSON.parse(readFileSync(require.resolve("@iconify-json/ph/icons.json"), "utf8")) as { icons: Record<string, { body: string }> };
      const bodies = Object.fromEntries(Object.entries(icons).map(([className, name]) => {
        const icon = set.icons[name];
        if (!icon) throw new TypeError(`The Phosphor icon "${name}" does not exist.`);
        return [className, shapes(name, icon.body)];
      }));
      return `export const icons = ${JSON.stringify(bodies)};`;
    },
    transform(code, id) {
      if (!/[\\/]ui[\\/]styles\.css$/.test(id)) return undefined;
      return code.replace(/^@import\s+["'](?:katex\/dist\/katex\.min\.css|comark-chat\/style\.css)["'];?\s*$/gm, "");
    },
  };
}
