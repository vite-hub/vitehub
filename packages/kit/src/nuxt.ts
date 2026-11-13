import { defineNuxtModule, installModule } from "@nuxt/kit";
import uiSdk from "@ui-sdk/vue/nuxt";

export interface KitNuxtOptions {
  /** Prefix for auto-imported component names, for example `Ui` registers `UiDialogTrigger`. Empty by default. */
  prefix?: string;
}

export interface KitNuxtModule {
  (inlineOptions: KitNuxtOptions, nuxt: never): unknown;
  getMeta?: () => Promise<Record<string, unknown>>;
}

const uiSdkEntry = "@ui-sdk/vue/";
const kitEntry = "@vite-hub/kit/";

function toKitEntry(path: string): string {
  return path.startsWith(uiSdkEntry) ? kitEntry + path.slice(uiSdkEntry.length) : path;
}

/**
 * Auto-imports every part and helper of ui-sdk in a Nuxt app. The ui-sdk Nuxt module does the registration. This
 * module only moves the import paths from `@ui-sdk/vue/<entry>` to `@vite-hub/kit/<entry>`. The app installs
 * `@vite-hub/kit`, and with pnpm it cannot resolve `@ui-sdk/vue`. The build still works, but the generated types of
 * `.nuxt/components.d.ts` and `.nuxt/imports.d.ts` do not resolve, so every part and helper has the type `any`.
 */
const kitNuxtModule: KitNuxtModule = defineNuxtModule<KitNuxtOptions>({
  meta: { configKey: "viteHubKit", name: "@vite-hub/kit" },
  defaults: { prefix: "" },
  async setup({ prefix = "" }, nuxt) {
    await installModule(uiSdk, { prefix }, nuxt);
    // These hooks run after the ones that ui-sdk added, so they see its registrations.
    nuxt.hook("components:extend", (components) => {
      for (const component of components) component.filePath = toKitEntry(component.filePath);
    });
    nuxt.hook("imports:sources", (sources) => {
      for (const source of sources) if ("from" in source) source.from = toKitEntry(source.from);
    });
  },
});

export default kitNuxtModule;
