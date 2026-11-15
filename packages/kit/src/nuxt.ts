import { addComponent, defineNuxtModule } from "@nuxt/kit";
import type { ModuleSetupReturn } from "@nuxt/schema";

import { ownEntries } from "./parts/own-entries.ts";

export interface KitNuxtOptions {
  /** Prefix for auto-imported component names, for example `Ui` registers `UiTagsInput`. Use the same one as `uiSdk.prefix`. Empty by default. */
  prefix?: string;
}

// Nuxt stable and nightly carry different instance types. A method signature keeps
// the callable compatible with either while the implementation uses @nuxt/kit's types.
export type KitNuxtModule = {
  setup(inlineOptions: KitNuxtOptions, nuxt: object): ModuleSetupReturn;
}["setup"] & { getMeta?: () => Promise<Record<string, unknown>> };

declare module "@nuxt/schema" {
  interface NuxtConfig {
    viteHubKit?: KitNuxtOptions;
  }
  interface NuxtOptions {
    viteHubKit?: KitNuxtOptions;
  }
}

declare module "nuxt/schema" {
  interface NuxtConfig {
    viteHubKit?: KitNuxtOptions;
  }
  interface NuxtOptions {
    viteHubKit?: KitNuxtOptions;
  }
}

const kitEntry = "@vite-hub/kit/";

/**
 * Auto-imports the kit's own parts in a Nuxt app, such as `<TagsInput>`. For every ui-sdk part, add `@ui-sdk/vue/nuxt`
 * next to it and install `@ui-sdk/vue` and `@ui-sdk/core` in the app.
 */
const kitNuxtModule: KitNuxtModule = defineNuxtModule<KitNuxtOptions>({
  meta: { configKey: "viteHubKit", name: "@vite-hub/kit" },
  defaults: { prefix: "" },
  setup({ prefix = "" }) {
    for (const [entry, names] of Object.entries(ownEntries)) {
      for (const name of names) addComponent({ name: prefix + name, export: name, filePath: kitEntry + entry });
    }
  },
});

export default kitNuxtModule;
