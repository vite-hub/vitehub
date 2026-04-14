import { resolve } from "node:path";
import { defineNuxtModule } from "nuxt/kit";
import { readDocsArtifactsManifest, writeDocsArtifacts } from "./artifacts";

const frameworkIds = ["vite", "nitro", "nuxt"] as const;

export default defineNuxtModule({
  meta: {
    name: "vitehub-docs",
  },
  async setup(_options, nuxt) {
    const docsRoot = nuxt.options.rootDir;
    const repoRoot = resolve(docsRoot, "..");
    const outputDir = resolve(docsRoot, ".generated");

    const manifest = readDocsArtifactsManifest(outputDir) || writeDocsArtifacts({ docsRoot, repoRoot, outputDir });
    nuxt.options.alias["#vitehub-docs-manifest"] = resolve(outputDir, "docs-manifest.mjs");

    // Prerender all framework variants (only nuxt is link-crawlable, vite/nitro are client-switched)
    const prerenderRoutes: string[] = [];
    for (const section of manifest.sections) {
      for (const page of section.pages) {
        for (const fw of frameworkIds) {
          if (page.frameworks.includes(fw)) {
            const path = page.id === "index" ? `/docs/${fw}/${section.id}` : `/docs/${fw}/${section.id}/${page.id}`;
            prerenderRoutes.push(path);
          }
        }
      }
    }
    nuxt.options.nitro ||= {};
    nuxt.options.nitro.prerender ||= {};
    nuxt.options.nitro.prerender.routes = [...new Set([
      ...(nuxt.options.nitro.prerender.routes || []),
      ...prerenderRoutes,
    ])];

    // Remove Docus catch-all page — ViteHub uses /docs/[framework]/[...slug] routing
    nuxt.hook("pages:extend", (pages) => {
      const catchAllIndex = pages.findIndex(page => page.path === "/:lang?/:slug(.*)*" || page.file?.includes("[[lang]]"));
      if (catchAllIndex !== -1) pages.splice(catchAllIndex, 1);
    });

    // Regenerate artifacts when showcase examples change (Content handles markdown HMR)
    nuxt.hook("builder:watch", async (_event, path) => {
      if (!path.includes("/packages/") || !path.includes("/examples/")) return;
      writeDocsArtifacts({ docsRoot, repoRoot, outputDir });
    });
  },
});
