import { resolve } from "node:path";
import { defineNuxtModule } from "nuxt/kit";
import { readDocsArtifactsManifest, writeDocsArtifacts } from "./artifacts";

function collectPrerenderRoutes(manifest: NonNullable<ReturnType<typeof readDocsArtifactsManifest>>) {
  const routes: string[] = ["/docs"];

  for (const section of manifest.sections) {
    for (const page of section.pages) {
      routes.push(page.path);
    }
  }

  return routes;
}

function removeDocusCatchAllPage(pages: Array<{ path?: string, file?: string }>) {
  const catchAllIndex = pages.findIndex(page => page.path === "/:lang?/:slug(.*)*" || page.file?.includes("[[lang]]"));
  if (catchAllIndex !== -1) {
    pages.splice(catchAllIndex, 1);
  }
}

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
    nuxt.hook("prerender:routes", (context) => {
      for (const route of collectPrerenderRoutes(manifest)) {
        context.routes.add(route);
      }
    });

    // Remove Docus catch-all page; ViteHub owns the docs route shell.
    nuxt.hook("pages:extend", removeDocusCatchAllPage);

    // Regenerate artifacts when showcase examples change (Content handles markdown HMR).
    nuxt.hook("builder:watch", async (_event, path) => {
      if (!path.includes("/packages/") || !path.includes("/examples/")) return;
      writeDocsArtifacts({ docsRoot, repoRoot, outputDir });
    });
  },
});
