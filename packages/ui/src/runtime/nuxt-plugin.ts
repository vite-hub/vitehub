import { defineNuxtPlugin, useRuntimeConfig } from "#app";
import { defineAsyncComponent } from "vue";
import { createViteHubUI, type ViteHubUIOptions } from "../config.ts";

const viteHubUIPlugin: unknown = defineNuxtPlugin((nuxtApp) => {
  const options = useRuntimeConfig().public.viteHubUI as ViteHubUIOptions | undefined;
  // In Nuxt, icons come from the @nuxt/icon bundle through Nuxt UI's Nuxt icon. The parts default to the Vue one.
  const UIcon = defineAsyncComponent(() => import("@nuxt/ui/components/Icon.vue"));
  nuxtApp.vueApp.use(createViteHubUI({ ...options, components: { UIcon } }));
});

export default viteHubUIPlugin;
