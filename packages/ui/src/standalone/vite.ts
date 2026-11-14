import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..");
const virtualIcons = "virtual:vitehub-ui-icons";
const nuxtUI = "\0vitehub-ui-standalone:";
// The stylesheet imports of the Chat, KaTeX, and WorkspaceTerminal styles.
const unusedStyles = /@import\s+["'](?:katex\/dist\/katex\.min\.css|comark-chat\/style\.css|@xterm\/xterm\/css\/xterm\.css)["']/;

// The Nuxt UI components that the parts import, and the stand-in of `nuxt-ui.ts` that each one becomes. The parts load
// them on first render (see `internal/nuxt-ui.ts`), so the others, such as the Chat ones, render nothing.
const standIns: Record<string, string> = {
  "@nuxt/ui/components/Button.vue": "UButton",
  "@nuxt/ui/components/Icon.vue": "UIcon",
  "@nuxt/ui/components/Modal.vue": "UModal",
  "@nuxt/ui/runtime/vue/components/Icon.vue": "UIcon",
};

// The Lucide icons that the comment parts, the Prompt Input, and the image preview ask for by class name.
const icons: Record<string, string> = Object.fromEntries([
  "arrow-left",
  "arrow-up",
  "check",
  "external-link",
  "file",
  "list",
  "message-circle",
  "pencil",
  "plus",
  "refresh-cw",
  "rotate-ccw",
  "square",
  "square-pen",
  "trash-2",
  "x",
].map(name => [`i-lucide-${name}`, name]));

const elementPattern = /<(\w+)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g;

function attributesOf(source: string): Record<string, string> {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, value!]));
}

// The icons are drawn from elements, never from markup, so a flat list of shapes is all that they need. A Lucide icon
// with several shapes wraps them in one `<g>` that holds the stroke, so each shape takes the attributes of the group.
function shapes(name: string, body: string): Array<[string, Record<string, string>]> {
  const group = /^<g((?:\s+[\w:-]+="[^"]*")*)>(.*)<\/g>$/s.exec(body);
  const shared = group ? attributesOf(group[1]!) : {};
  const content = group ? group[2]! : body;
  const found: Array<[string, Record<string, string>]> = [];
  for (const [, tag, attributes] of content.matchAll(elementPattern)) {
    if (tag === "g" || tag === "svg") throw new TypeError(`The Lucide icon "${name}" nests elements, which the stand-in UIcon does not draw.`);
    found.push([tag!, { ...shared, ...attributesOf(attributes!) }]);
  }
  if (!found.length || content.replaceAll(elementPattern, "").trim()) throw new TypeError(`The Lucide icon "${name}" has a body that the stand-in UIcon cannot draw: ${body}`);
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
 * - the stylesheet loses its Chat, KaTeX, and terminal imports, which the comment parts do not use.
 */
export function standaloneUI(): Plugin {
  return {
    name: "vitehub-ui-standalone",
    enforce: "pre",
    resolveId: {
      filter: { id: [/^virtual:vitehub-ui-icons$/, /^@nuxt\/ui\//, /(?:^|\/)markdown\.ts$/] },
      handler(id, importer) {
        if (id === virtualIcons) return `\0${virtualIcons}`;
        if (id.startsWith("@nuxt/ui/")) return `${nuxtUI}${id}`;
        if (importer?.startsWith(source) && !importer.startsWith(here) && /(^|\/)markdown\.ts$/.test(id)) return resolve(here, "markdown.ts");
        return undefined;
      },
    },
    load: {
      filter: { id: [/^\0vitehub-ui-standalone:/, /^\0virtual:vitehub-ui-icons$/] },
      handler(id) {
        if (id.startsWith(nuxtUI)) {
          const name = standIns[id.slice(nuxtUI.length)];
          return name
            ? `export { ${name} as default } from ${JSON.stringify(resolve(here, "nuxt-ui.ts"))};`
            : "export default { name: \"NuxtUIStandIn\", render: () => null };";
        }
        if (id !== `\0${virtualIcons}`) return undefined;
        const require = createRequire(import.meta.url);
        const set = JSON.parse(readFileSync(require.resolve("@iconify-json/lucide/icons.json"), "utf8")) as { aliases?: Record<string, { parent: string }>, icons: Record<string, { body: string }> };
        const bodies = Object.fromEntries(Object.entries(icons).map(([className, name]) => {
          // Lucide keeps renamed icons, such as `trash-2`, as aliases of the current name.
          const icon = set.icons[name] ?? set.icons[set.aliases?.[name]?.parent ?? ""];
          if (!icon) throw new TypeError(`The Lucide icon "${name}" does not exist.`);
          return [className, shapes(name, icon.body)];
        }));
        return `export const icons = ${JSON.stringify(bodies)};`;
      },
    },
    transform: {
      // The handler changes only the stylesheet's Chat, KaTeX, and terminal imports and the parts' dynamic Nuxt UI imports.
      filter: { code: [unusedStyles, /\bimport\(\s*["']@nuxt\/ui\//] },
      handler(code, id) {
        // An overlay imports the stylesheet with `?inline`.
        if (/[\\/]ui[\\/]styles\.css(?:\?.*)?$/.test(id)) return code.replace(new RegExp(`^${unusedStyles.source}[^;\\n]*;?\\s*$`, "gm"), "");
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
    },
  };
}
