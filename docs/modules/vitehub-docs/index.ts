import { resolve } from "node:path";
import { defineNuxtModule } from "nuxt/kit";
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
    const docsRoot = nuxt.options.rootDir;
    const repoRoot = resolve(docsRoot, "..");
    const outputDir = resolve(docsRoot, ".generated");
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

    nuxt.hook("pages:extend", (pages) => {
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
