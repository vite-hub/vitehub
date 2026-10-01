import { resolve } from "node:path";
import { addServerHandler, defineNuxtModule } from "nuxt/kit";
import { writeDocsArtifacts } from "./artifacts";
import { laneLlmsRoutes } from "./runtime/utils/lane-llms";
import { createCapabilityReferences, writeCapabilityReferences } from "./capability-references";
import { createDocsRedirectRouteRules } from "./redirects";

function collectPrerenderRoutes(manifest: { sections: Array<{ pages: Array<{ path: string }> }> }) {
  const routes: string[] = ["/docs", "/about", "/contact", "/privacy"];

  for (const section of manifest.sections) {
    for (const page of section.pages) {
      if (page.path === "/docs/frameworks-hosts/support-matrix") continue;
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

export function isDocsArtifactSource(path: string) {
  const normalizedPath = path.replace(/\\/g, "/");
  return /content\/(?:docs|blog|trust)\/.*\.md$/.test(normalizedPath)
    || /content\/docs\/(?:.*\/)?\.navigation\.yml$/.test(normalizedPath);
}

export default defineNuxtModule({
  meta: {
    name: "vitehub-docs",
  },
  async setup(_options, nuxt) {
    const docsRoot = nuxt.options.rootDir;
    const outputDir = resolve(docsRoot, ".generated");
    const agentErrorHandler = resolve(docsRoot, "server/error-handler.ts");
    const llmsRawLinksPlugin = resolve(docsRoot, "modules/vitehub-docs/runtime/server/llms-raw-links.ts");

    const capabilityReferences = await createCapabilityReferences();
    const capabilityReferencesPath = writeCapabilityReferences(outputDir, capabilityReferences);
    const manifest = writeDocsArtifacts({ capabilityReferences, docsRoot, outputDir });
    nuxt.options.alias["#vitehub-capability-references"] = capabilityReferencesPath;
    nuxt.options.alias["#vitehub-docs-manifest"] = resolve(outputDir, "docs-manifest.mjs");
    // Explicit route rules in nuxt.config.ts take precedence over removed-page redirects.
    nuxt.options.routeRules = { ...createDocsRedirectRouteRules(), ...nuxt.options.routeRules };
    nuxt.hook("builder:watch", (_event, path) => {
      if (isDocsArtifactSource(path)) {
        writeDocsArtifacts({ capabilityReferences, docsRoot, outputDir });
      }
    });
    addServerHandler({
      route: "/llms/:lane",
      handler: resolve(docsRoot, "modules/vitehub-docs/runtime/server/llms-lane.ts"),
    });
    nuxt.hook("prerender:routes", (context) => {
      for (const route of [...collectPrerenderRoutes(manifest), ...laneLlmsRoutes()]) {
        context.routes.add(route);
      }
    });
    nuxt.hook("nitro:config", (config) => {
      const configuredHandlers = config.errorHandler
        ? Array.isArray(config.errorHandler) ? config.errorHandler : [config.errorHandler]
        : [];
      config.errorHandler = [agentErrorHandler, ...configuredHandlers];
      config.publicAssets ||= [];
      config.publicAssets.push({
        baseURL: "/raw",
        dir: resolve(outputDir, "raw"),
        maxAge: 300,
      });
      config.plugins ||= [];
      config.plugins.push(llmsRawLinksPlugin);
    });

    // Remove Docus catch-all page; ViteHub owns the docs route shell.
    nuxt.hook("pages:extend", removeDocusCatchAllPage);
  },
});
