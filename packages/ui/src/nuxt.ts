import {
  addComponent,
  createResolver,
  defineNuxtModule,
  runWithNuxtContext,
} from "@nuxt/kit";
import { createRequire } from "node:module";
import { icons as viteHubIcons } from "@vite-hub/icons";
import type { ViteHubUIIconOptions, ViteHubUIOptions } from "./config.ts";
import { componentNames } from "./component-names.ts";
import { viteHubUIIcons } from "./icons.ts";

// Components are not serializable, so the module takes the path of a module that exports them. Icons come from the app
// config, below.
export interface ViteHubUINuxtOptions extends Omit<ViteHubUIOptions, "components" | "icons">, ViteHubUIRuntimeOptions {
  /** Prefix for auto-imported component names, for example `Vh` registers `VhTrace`. Use it when the app has its own `Message` or `Trace`. */
  prefix?: string;
}

export interface ViteHubUIRuntimeOptions {
  /**
   * The path of a module that default-exports the components that the parts render instead of the ui-sdk ones, such as
   * Nuxt UI's. The plugin gives them to `createViteHubUI({ components })`.
   */
  components?: string;
}

export interface ViteHubUINuxtModule {
  (inlineOptions: ViteHubUINuxtOptions, nuxt: never): unknown;
  getMeta?: () => Promise<Record<string, unknown>>;
}

declare module "@nuxt/schema" {
  interface AppConfigInput {
    /** The icons of the parts that Nuxt UI's `appConfig.ui.icons` has no name for, such as `edit` and `delete`. */
    viteHubUI?: { icons?: ViteHubUIIconOptions };
  }
}

/** Vite's `resolve.alias`: a list of entries, or a record of replacements. The declarations do not import Vite, an optional peer. */
type ViteAliasOptions = readonly { find: string | RegExp; replacement: string }[] | { [find: string]: string };

/** The parts of a Nuxt instance that `addViteHubUIRuntime()` uses. */
export interface ViteHubUIRuntimeNuxt {
  options: { plugins: Array<string | { src: string }>; vite: { resolve?: { alias?: ViteAliasOptions } } };
  hook: (name: "icon:clientBundleIcons", callback: (icons: Set<string>) => void) => unknown;
}

const componentsModule = "virtual:vitehub-ui-components";

/**
 * Adds what the styled parts need at runtime in a Nuxt app: the plugin that installs `createViteHubUI()` with the
 * components of `options.components`, their icons in the `@nuxt/icon` client bundle, because `@nuxt/icon` does not
 * scan dependencies, and Shiki's WebAssembly as a module the server build can bundle. The module calls it, and so does
 * `vite-hub/nuxt` when the app installed this package. It is safe to call twice: a call with `components` wins.
 */
export function addViteHubUIRuntime(nuxt: ViteHubUIRuntimeNuxt, options: ViteHubUIRuntimeOptions = {}): void {
  const resolver = createResolver(import.meta.url);
  const plugin = resolver.resolve("./runtime/nuxt-plugin.js");
  if (!nuxt.options.plugins.some((entry) => (typeof entry === "string" ? entry : entry.src) === plugin)) nuxt.options.plugins.push(plugin);
  nuxt.hook("icon:clientBundleIcons", (icons) => {
    for (const icon of viteHubUIIcons) icons.add(icon);
  });
  setAlias(nuxt.options.vite, componentsModule, options.components ?? resolver.resolve("./runtime/no-components.js"), options.components !== undefined);
  inlineShikiWasm(nuxt.options.vite);
}

function setAlias(vite: ViteHubUIRuntimeNuxt["options"]["vite"], find: string, replacement: string, replace: boolean): void {
  const resolve = (vite.resolve ??= {});
  const alias = resolve.alias ?? [];
  if (!Array.isArray(alias)) {
    if (replace || !(find in alias)) resolve.alias = { ...alias, [find]: replacement };
    return;
  }
  const current = alias.some((entry) => entry.find === find);
  if (current && !replace) return;
  resolve.alias = [...alias.filter((entry) => entry.find !== find), { find, replacement }];
}

/**
 * Comark highlights code with the `shiki` root, which loads `shiki/wasm` on demand. Nitro builds the server with Shiki's
 * `unwasm` export condition, which points at the raw `onig.wasm`, and that file imports its JavaScript glue as `env`, so
 * Rolldown stops with `failed to resolve import "env"`. Resolve `shiki/wasm` to the base64 module of the `default`
 * condition, from this package's Shiki so that the app needs no direct dependency.
 * The cause is in Nitro: Vite service environments resolve the `unwasm` condition, but only the Nitro environment runs
 * unwasm. Remove when Nitro fixes it (https://github.com/nitrojs/nitro/issues/5150).
 */
function inlineShikiWasm(vite: ViteHubUIRuntimeNuxt["options"]["vite"]): void {
  const shiki = createRequire(import.meta.url).resolve("shiki/package.json");
  setAlias(vite, "shiki/wasm", createRequire(shiki).resolve("@shikijs/engine-oniguruma/wasm-inlined"), false);
}

export { viteHubUIIcons };

const registeredComponentPrefixes = new WeakMap<object, Set<string>>();

/**
 * Auto-imports the public components in a Nuxt app, with an optional name prefix. The module calls it, and so does
 * `vite-hub/nuxt` when the app installed this package and Nuxt UI. It registers each prefix once per Nuxt instance.
 * Nuxt only bundles a component that a template uses, so an app that renders none pays nothing.
 */
export function addViteHubUIComponents(nuxt: object, prefix = ""): void {
  const prefixes = registeredComponentPrefixes.get(nuxt) ?? new Set<string>();
  if (prefixes.has(prefix)) return;
  prefixes.add(prefix);
  registeredComponentPrefixes.set(nuxt, prefixes);
  const componentsFile = createResolver(import.meta.url).resolve("./index.js");
  // SAFETY: Callers pass the Nuxt instance that runs their module; `addComponent` only reads its options and hooks.
  runWithNuxtContext(nuxt as Parameters<typeof runWithNuxtContext>[0], () => {
    for (const name of componentNames)
      addComponent({ export: name, filePath: componentsFile, name: `${prefix}${name}` });
  });
}

// Nuxt reads dependency defaults before module setup, including when vite-hub/nuxt installs the runtime alone.
export const viteHubUIIconDependencies = {
  "@nuxt/icon": { optional: true, defaults: { customCollections: [viteHubIcons] } },
};

const viteHubUINuxtModule: ViteHubUINuxtModule = defineNuxtModule<ViteHubUINuxtOptions>({
  meta: { configKey: "viteHubUI", name: "@vite-hub/ui" },
  defaults: {},
  moduleDependencies: viteHubUIIconDependencies,
  async setup({ components, prefix = "", ...options }, nuxt) {
    const resolver = createResolver(import.meta.url);
    nuxt.options.css.push(resolver.resolve("./styles.css"));
    nuxt.options.runtimeConfig.public.viteHubUI = options;
    addViteHubUIRuntime(nuxt, { components });
    addViteHubUIComponents(nuxt, prefix);
  },
});

export default viteHubUINuxtModule;
