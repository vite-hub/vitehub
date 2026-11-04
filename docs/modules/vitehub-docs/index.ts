import { addTemplate, defineNuxtModule } from "nuxt/kit";
import { capabilityReferences } from "./capability-references";
import { createDocsRedirectRouteRules } from "./redirects";

// ViteHub's own docs pieces on top of @vite-hub/docs: redirects of moved pages and the Agent Capability tool contracts.
export default defineNuxtModule({
  meta: {
    name: "vitehub-docs",
  },
  async setup(_options, nuxt) {
    const references = await capabilityReferences();
    nuxt.options.alias["#vitehub-capability-references"] = addTemplate({
      filename: "vitehub/capability-references.mjs",
      write: true,
      getContents: () => `export default ${JSON.stringify(references)};\n`,
    }).dst;
    // Explicit route rules in nuxt.config.ts take precedence over removed-page redirects.
    nuxt.options.routeRules = { ...createDocsRedirectRouteRules(), ...nuxt.options.routeRules };
  },
});
