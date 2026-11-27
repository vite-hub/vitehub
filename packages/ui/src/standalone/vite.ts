import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invariant } from "@vite-hub/internal/invariant";
import type { Plugin } from "vite";

import { iconShapes } from "../internal/icon-shapes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "..");
const virtualIcons = "virtual:vitehub-ui-icons";
// The stylesheet imports of the Chat, KaTeX, and WorkspaceTerminal styles.
const unusedStyles = /@import\s+["'](?:katex\/dist\/katex\.min\.css|comark-chat\/style\.css|@xterm\/xterm\/css\/xterm\.css)["']/;

// The parts load their default components on first render with this import of `internal/nuxt-ui.ts`.
const defaultSet = /\bimport\(\s*["']\.\.\/ui-sdk\/components\.ts["']\s*\)/;

const icons: Record<string, string> = Object.fromEntries([
  "arrow-left",
  "arrow-up",
  "arrow-up-right",
  "check",
  "circle-alert",
  "copy",
  "external-link",
  "file",
  "inbox",
  "list",
  "loader-circle",
  "message-circle",
  "pencil",
  "plus",
  "refresh-cw",
  "rotate-ccw",
  "send",
  "square",
  "square-pen",
  "trash-2",
  "x",
].map(name => [`i-lucide-${name}`, name]));

/**
 * Lets the styled parts run without Nuxt UI, such as in an overlay that a page loads into a shadow root. It is the one
 * place that builds without Nuxt UI get their stand-ins from:
 *
 * - the default components of the parts become the stand-ins of `standalone/nuxt-ui.ts`, or components that render
 *   nothing, instead of the ui-sdk set;
 * - the Markdown part becomes `standalone/markdown.ts`, which has no parser, highlighter, or KaTeX;
 * - `UIcon` gets its icons as shapes;
 * - the stylesheet loses its Chat, KaTeX, and terminal imports, which the comment parts do not use.
 */
export function standaloneUI(): Plugin {
  return {
    name: "vitehub-ui-standalone",
    enforce: "pre",
    resolveId: {
      filter: { id: [/^virtual:vitehub-ui-icons$/, /(?:^|\/)markdown\.ts$/] },
      handler(id, importer) {
        if (id === virtualIcons) return `\0${virtualIcons}`;
        if (importer?.startsWith(source) && !importer.startsWith(here) && /(^|\/)markdown\.ts$/.test(id)) return resolve(here, "markdown.ts");
        return undefined;
      },
    },
    load: {
      filter: { id: [/^\0virtual:vitehub-ui-icons$/] },
      handler(id) {
        if (id !== `\0${virtualIcons}`) return undefined;
        const require = createRequire(import.meta.url);
        const set = JSON.parse(readFileSync(require.resolve("@iconify-json/lucide/icons.json"), "utf8")) as { aliases?: Record<string, { parent: string }>, icons: Record<string, { body: string }> };
        const bodies = Object.fromEntries(Object.entries(icons).map(([className, name]) => {
          // Lucide keeps renamed icons, such as `trash-2`, as aliases of the current name.
          const icon = set.icons[name] ?? set.icons[set.aliases?.[name]?.parent ?? ""];
          invariant(icon, `the pinned Lucide set has the icon "${name}" of the fixed icon list`);
          return [className, iconShapes(name, icon.body)];
        }));
        return `export const icons = ${JSON.stringify(bodies)};`;
      },
    },
    transform: {
      // The handler changes only the stylesheet's Chat, KaTeX, and terminal imports and the import of the default set.
      filter: { code: [unusedStyles, defaultSet] },
      handler(code, id) {
        // An overlay imports the stylesheet with `?inline`.
        if (/[\\/]ui[\\/]styles\.css(?:\?.*)?$/.test(id)) return code.replace(new RegExp(`^${unusedStyles.source}[^;\\n]*;?\\s*$`, "gm"), "");
        // The stand-ins are small, so they come along at once, and the build does not split the page's bundle around them.
        if (!/[\\/]internal[\\/]nuxt-ui\.ts$/.test(id) || !defaultSet.test(code)) return undefined;
        return { code: `import * as __standIns from ${JSON.stringify(resolve(here, "nuxt-ui.ts"))};\n${code.replace(defaultSet, "Promise.resolve(__standIns)")}`, map: null };
      },
    },
  };
}
