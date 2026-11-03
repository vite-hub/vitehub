import {
  addComponent,
  addPlugin,
  createResolver,
  defineNuxtModule,
  installModule,
} from "@nuxt/kit";
import { icons as viteHubIcons } from "@vite-hub/icons";
import type { ViteHubUIOptions } from "./config.ts";
import { componentNames } from "./component-entries.ts";
import { viteHubUIIcons } from "./icons.ts";

export interface ViteHubUINuxtOptions extends ViteHubUIOptions {
  /** Prefix for auto-imported component names, for example `Vh` registers `VhTrace`. Use it when the app has its own `Message` or `Trace`. */
  prefix?: string;
}

export interface ViteHubUINuxtModule {
  (inlineOptions: ViteHubUINuxtOptions, nuxt: never): unknown;
  getMeta?: () => Promise<Record<string, unknown>>;
}

const viteHubUINuxtModule: ViteHubUINuxtModule = defineNuxtModule<ViteHubUINuxtOptions>({
  meta: { configKey: "viteHubUI", name: "@vite-hub/ui" },
  defaults: {},
  // The `vitehub` Iconify collection, so `i-vitehub-kv` resolves in the app like the icons of an `@iconify-json/*` package.
  // @nuxt/ui installs @nuxt/icon, so this only adds options and does not install it a second time.
  moduleDependencies: {
    "@nuxt/icon": { optional: true, defaults: { customCollections: [viteHubIcons] } },
  },
  async setup({ prefix = "", ...options }, nuxt) {
    const resolver = createResolver(import.meta.url);
    await installModule("@nuxt/ui", {}, nuxt);
    nuxt.options.css.push(resolver.resolve("./styles.css"));
    nuxt.options.runtimeConfig.public.viteHubUI = options;
    addPlugin(resolver.resolve("./runtime/nuxt-plugin.js"));
    const componentsFile = resolver.resolve("./index.js");
    for (const name of componentNames)
      addComponent({ export: name, filePath: componentsFile, name: `${prefix}${name}` });
    // @nuxt/icon does not scan dependencies, so add the icons these components use to its client bundle.
    nuxt.hook("icon:clientBundleIcons", (icons) => {
      for (const icon of viteHubUIIcons) icons.add(icon);
    });
  },
});

export default viteHubUINuxtModule;
