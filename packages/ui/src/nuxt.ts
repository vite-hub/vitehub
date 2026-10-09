import {
  addComponent,
  addPlugin,
  createResolver,
  defineNuxtModule,
  installModule,
} from "@nuxt/kit";
import type { ViteHubUIOptions } from "./config.ts";
import { componentEntryName, componentNames } from "./component-entries.ts";
import { viteHubUIIcons } from "./icons.ts";

export interface ViteHubUINuxtModule {
  (inlineOptions: ViteHubUIOptions, nuxt: never): unknown;
  getMeta?: () => Promise<Record<string, unknown>>;
}

const viteHubUINuxtModule: ViteHubUINuxtModule = defineNuxtModule<ViteHubUIOptions>({
  meta: { configKey: "viteHubUI", name: "@vite-hub/ui" },
  defaults: {},
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url);
    await installModule("@nuxt/ui", {}, nuxt);
    nuxt.options.css.push(resolver.resolve("./styles.css"));
    nuxt.options.runtimeConfig.public.viteHubUI = options;
    addPlugin(resolver.resolve("./runtime/nuxt-plugin.js"));
    for (const name of componentNames)
      addComponent({ export: name, filePath: resolver.resolve(`./${componentEntryName(name)}.js`), name });
    // @nuxt/icon does not scan dependencies, so add the icons these components use to its client bundle.
    nuxt.hook("icon:clientBundleIcons", (icons) => {
      for (const icon of viteHubUIIcons) icons.add(icon);
    });
  },
});

export default viteHubUINuxtModule;
