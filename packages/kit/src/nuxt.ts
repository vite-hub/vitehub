import { addComponent, defineNuxtModule } from "@nuxt/kit";
import type { ModuleSetupReturn } from "@nuxt/schema";

import { ownEntries } from "./parts/own-entries.ts";

export interface KitNuxtOptions {
  /** Prefix for auto-imported component names, for example `Ui` registers `UiTagsInput`. Use the same one as `uiSdk.prefix`. Empty by default. */
  prefix?: string;
}

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
