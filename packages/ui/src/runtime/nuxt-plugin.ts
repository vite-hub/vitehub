import { defineNuxtPlugin, useAppConfig, useRuntimeConfig } from "#app";
import { defineAsyncComponent } from "vue";
import { createViteHubUI, type ViteHubUIIconOptions, type ViteHubUIOptions } from "../config.ts";

const viteHubUIPlugin: unknown = defineNuxtPlugin((nuxtApp) => {
  const options = useRuntimeConfig().public.viteHubUI as ViteHubUIOptions | undefined;
  // In Nuxt, icons come from the @nuxt/icon bundle through Nuxt UI's Nuxt icon. The parts default to the Vue one.
  const UIcon = defineAsyncComponent(() => import("@nuxt/ui/components/Icon.vue"));
  // The parts take their icons from Nuxt UI's app config, as Nuxt UI's own components do. The object stays reactive.
  nuxtApp.vueApp.use(createViteHubUI({ ...options, components: { UIcon }, icons: appConfigIcons(useAppConfig().ui) }));
});

function appConfigIcons(ui: unknown): ViteHubUIIconOptions | undefined {
  if (typeof ui !== "object" || ui === null || !("icons" in ui)) return undefined;
  const icons: unknown = ui.icons;
  return typeof icons === "object" && icons !== null ? icons : undefined;
}

export default viteHubUIPlugin;
