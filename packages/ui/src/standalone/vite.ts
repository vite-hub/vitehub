import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..");
const virtualIcons = "virtual:vitehub-ui-icons";
const nuxtUI = "\0vitehub-ui-standalone:";

// The Nuxt UI components that the parts import, and the stand-in of `nuxt-ui.ts` that each one becomes. The parts load
// them on first render (see `internal/nuxt-ui.ts`), so the others, such as the Chat ones, render nothing.
const standIns: Record<string, string> = {
  "@nuxt/ui/components/Button.vue": "UButton",
  "@nuxt/ui/components/Icon.vue": "UIcon",
  "@nuxt/ui/components/Modal.vue": "UModal",
  "@nuxt/ui/runtime/vue/components/Icon.vue": "UIcon",
};

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
 * Lets the styled parts run without Nuxt UI, such as in an overlay that a page loads into a shadow root. It is the one
 * place that builds without Nuxt UI get their stand-ins from:
 *
 * - every `@nuxt/ui/*` import, also a dynamic one, becomes a stand-in of `standalone/nuxt-ui.ts`, or a component that
 *   renders nothing;
 * - the Markdown part becomes `standalone/markdown.ts`, which has no parser, highlighter, or KaTeX;
 * - `UIcon` gets its icons as shapes;
 * - the stylesheet loses its Chat and KaTeX imports, which the comment parts do not use.
 */
export function standaloneUI(): Plugin {
  return {
    name: "vitehub-ui-standalone",
    enforce: "pre",
    resolveId(id, importer) {
      if (id === virtualIcons) return `\0${virtualIcons}`;
      if (id.startsWith("@nuxt/ui/")) return `${nuxtUI}${id}`;
      if (importer?.startsWith(source) && !importer.startsWith(here) && /(^|\/)markdown\.ts$/.test(id)) return resolve(here, "markdown.ts");
      return undefined;
    },
    load(id) {
      if (id.startsWith(nuxtUI)) {
        const name = standIns[id.slice(nuxtUI.length)];
        return name
          ? `export { ${name} as default } from ${JSON.stringify(resolve(here, "nuxt-ui.ts"))};`
          : "export default { name: \"NuxtUIStandIn\", render: () => null };";
      }
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
      if (/[\\/]ui[\\/]styles\.css$/.test(id)) return code.replace(/^@import\s+["'](?:katex\/dist\/katex\.min\.css|comark-chat\/style\.css)["'];?\s*$/gm, "");
      // The parts load Nuxt UI on first render with `import()`. Its stand-ins are small, so they come along at once, and
      // the build does not split the page's bundle around them.
      if (!/\bimport\(\s*["']@nuxt\/ui\//.test(code)) return undefined;
      const imports: string[] = [];
      const body = code.replace(/\bimport\(\s*["'](@nuxt\/ui\/[^"']+)["']\s*\)/g, (_, path: string) => {
        imports.push(`import * as __standIn${imports.length} from ${JSON.stringify(path)};`);
        return `Promise.resolve(__standIn${imports.length - 1})`;
      });
      return { code: `${imports.join("\n")}\n${body}`, map: null };
    },
  };
}
