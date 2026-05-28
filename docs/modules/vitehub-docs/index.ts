import { resolve } from "node:path";
import { defineNuxtModule } from "nuxt/kit";
import type { NitroConfig } from "nitropack/types";
import { readDocsArtifactsManifest, writeDocsArtifacts } from "./artifacts";

const frameworkIds = ["vite", "nitro", "nuxt"] as const;

function collectPrerenderRoutes(manifest: NonNullable<ReturnType<typeof readDocsArtifactsManifest>>) {
  const routes: string[] = [];

  for (const section of manifest.sections) {
    for (const page of section.pages) {
      for (const framework of frameworkIds) {
        if (!page.frameworks.includes(framework)) {
          continue;
        }

        routes.push(page.id === "index"
          ? `/docs/${framework}/${section.id}`
          : `/docs/${framework}/${section.id}/${page.id}`);
      }
    }
  }

  return routes;
}

function extendNitroPrerenderRoutes(nuxt: { options: { nitro?: NitroConfig } & Record<string, any> }, routes: string[]) {
  const nitroOptions = ((nuxt.options as typeof nuxt.options & { nitro?: NitroConfig }).nitro ??= {});
  nitroOptions.prerender ??= {};
  nitroOptions.prerender.routes = [...new Set([
    ...(nitroOptions.prerender.routes || []),
    ...routes,
  ])];
}

function removeDocusCatchAllPage(pages: Array<{ path?: string, file?: string }>) {
  const catchAllIndex = pages.findIndex(page => page.path === "/:lang?/:slug(.*)*" || page.file?.includes("[[lang]]"));
  if (catchAllIndex !== -1) {
    pages.splice(catchAllIndex, 1);
  }
}

function shouldRegenerateDocsArtifacts(path: string) {
  const normalized = path.replace(/\\/g, "/");

  if (normalized.startsWith("content/docs/") || normalized.includes("/content/docs/")) {
    return true;
  }

  if (normalized.endsWith("/pnpm-workspace.yaml") || normalized === "pnpm-workspace.yaml") {
    return true;
  }

  if (!normalized.startsWith("packages/") && !normalized.includes("/packages/")) {
    return false;
  }

  return normalized.includes("/docs/")
    || normalized.includes("/examples/")
    || normalized.endsWith("/package.json");
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
    extendNitroPrerenderRoutes(nuxt, collectPrerenderRoutes(manifest));

    // Remove Docus catch-all page — ViteHub uses /docs/[framework]/[...slug] routing
    nuxt.hook("pages:extend", removeDocusCatchAllPage);

    // Nuxt Content handles markdown HMR; these artifacts feed navigation and examples.
    nuxt.hook("builder:watch", async (_event, path) => {
      if (!shouldRegenerateDocsArtifacts(path)) return;
      writeDocsArtifacts({ docsRoot, repoRoot, outputDir });
    });
  },
});
