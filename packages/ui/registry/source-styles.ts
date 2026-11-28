import { fileURLToPath } from "node:url";

const registryDir = fileURLToPath(new URL("./", import.meta.url));
const stub = "\0vitehub-registry-style";

/**
 * The npm package loads the stylesheet of each registry item from `styles.css`, and a registry item also imports the
 * core stylesheet, which a Nuxt UI app must not load. This plugin makes the CSS imports of the registry files empty,
 * for the package build and for an app that builds `@vite-hub/ui` from source.
 */
export function registrySourceStyles() {
  return {
    name: "vitehub-registry-source-styles",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
      if (source.endsWith(".css") && importer?.startsWith(registryDir)) return { id: stub, moduleSideEffects: false };
    },
    load(id: string) {
      if (id === stub) return "export {};";
    },
  };
}
