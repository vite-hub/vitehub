import {
  addComponent,
  createResolver,
  defineNuxtModule,
  installModule,
} from "@nuxt/kit";
import { icons as viteHubIcons } from "@vite-hub/icons";
import type { ViteHubUIOptions } from "./config.ts";
import { componentNames } from "./component-entries.ts";
import { viteHubUIIcons } from "./icons.ts";

// Components are not serializable, so the module takes the defaults only. Pass components to `createViteHubUI()` in a plugin.
export interface ViteHubUINuxtOptions extends Omit<ViteHubUIOptions, "components"> {
  /** Prefix for auto-imported component names, for example `Vh` registers `VhTrace`. Use it when the app has its own `Message` or `Trace`. */
  prefix?: string;
}

export interface ViteHubUINuxtModule {
  (inlineOptions: ViteHubUINuxtOptions, nuxt: never): unknown;
  getMeta?: () => Promise<Record<string, unknown>>;
}

/** The parts of a Nuxt instance that `addViteHubUIRuntime()` uses. */
export interface ViteHubUIRuntimeNuxt {
  options: { plugins: Array<string | { src: string }> };
  hook: (name: "icon:clientBundleIcons", callback: (icons: Set<string>) => void) => unknown;
}

/**
 * Adds what the styled parts need at runtime in a Nuxt app: the plugin that gives them Nuxt UI's Nuxt icon, and their
 * icons in the `@nuxt/icon` client bundle, because `@nuxt/icon` does not scan dependencies. The module calls it, and so
 * does `vite-hub/nuxt` when the app installed this package. It is safe to call twice.
 */
export function addViteHubUIRuntime(nuxt: ViteHubUIRuntimeNuxt): void {
  const plugin = createResolver(import.meta.url).resolve("./runtime/nuxt-plugin.js");
  if (!nuxt.options.plugins.some((entry) => (typeof entry === "string" ? entry : entry.src) === plugin)) nuxt.options.plugins.push(plugin);
  nuxt.hook("icon:clientBundleIcons", (icons) => {
    for (const icon of viteHubUIIcons) icons.add(icon);
  });
}

export { viteHubUIIcons };

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
    addViteHubUIRuntime(nuxt);
    const componentsFile = resolver.resolve("./index.js");
    for (const name of componentNames)
      addComponent({ export: name, filePath: componentsFile, name: `${prefix}${name}` });
  },
});

export default viteHubUINuxtModule;
