import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addComponentsDir,
  addImportsDir,
  createResolver,
  defineNuxtModule,
} from "nuxt/kit";
import { readDocsArtifactsManifest, writeDocsArtifacts } from "./artifacts";

function isDocsSourcePath(path: string) {
  return path.includes("/content/docs/")
    || path.includes("/packages/");
}

export default defineNuxtModule({
  meta: {
    name: "vitehub-docs",
  },
  async setup(_options, nuxt) {
    const resolver = createResolver(import.meta.url);
    const docsRoot = nuxt.options.rootDir;
    const repoRoot = resolve(docsRoot, "..");
    const outputDir = resolve(docsRoot, ".generated");
    const runtimeDir = resolver.resolve("./runtime");
    const nitroOptions = nuxt.options as typeof nuxt.options & {
      nitro?: {
        prerender?: {
          routes?: string[];
        };
      };
    };
    const basePrerenderRoutes = [...(nitroOptions.nitro?.prerender?.routes || [])];

    let manifest = readDocsArtifactsManifest(outputDir) || writeDocsArtifacts({ docsRoot, repoRoot, outputDir });
    nuxt.options.alias["#vitehub-docs-manifest"] = resolve(outputDir, "docs-manifest.mjs");

    addComponentsDir({
      path: resolve(runtimeDir, "components"),
      pathPrefix: false,
      global: true,
      priority: 1000,
    });
    addImportsDir(resolve(runtimeDir, "composables"));

    // Add runtime dir to Tailwind CSS v4 source scanning via @nuxt/ui's css template
    const uiCssPath = resolve(docsRoot, ".nuxt/ui.css");
    const sourceDirective = `@source "${runtimeDir}/**/*";\n`;
    function patchUiCss() {
      try {
        const existing = readFileSync(uiCssPath, "utf-8");
        if (!existing.includes(runtimeDir)) {
          writeFileSync(uiCssPath, sourceDirective + existing);
        }
      } catch {}
    }
    nuxt.hook("build:before", patchUiCss);
    nuxt.hook("builder:watch", () => patchUiCss());

    nuxt.hook("pages:extend", (pages) => {
      const docsPagePath = resolve(docsRoot, "app/pages/docs/[framework]/[...slug].vue");
      const hasFrameworkDocsRoute = pages.some(page => page.file === docsPagePath || page.path === "/docs/:framework/:slug(.*)*");

      if (!hasFrameworkDocsRoute) {
        pages.push({
          name: "vitehub-docs-framework-page",
          path: "/docs/:framework/:slug(.*)*",
          file: docsPagePath,
        });
      }

      // Remove Docus catch-all — our docs routes handle /docs/** and index.vue handles /
      const catchAllIndex = pages.findIndex(page => page.path === "/:lang?/:slug(.*)*" || page.file?.includes("[[lang]]"));
      if (catchAllIndex !== -1) pages.splice(catchAllIndex, 1);
    });

    function syncPrerenderRoutes() {
      nitroOptions.nitro ||= {};
      nitroOptions.nitro.prerender ||= {};
      nitroOptions.nitro.prerender.routes = [...new Set([
        ...basePrerenderRoutes,
        ...manifest.prerenderRoutes,
      ])];
    }

    function generateArtifacts() {
      manifest = writeDocsArtifacts({ docsRoot, repoRoot, outputDir });
      syncPrerenderRoutes();
    }

    syncPrerenderRoutes();

    nuxt.hook("builder:watch", async (_event, path) => {
      if (!isDocsSourcePath(path)) {
        return;
      }

      generateArtifacts();
    });
  },
});
