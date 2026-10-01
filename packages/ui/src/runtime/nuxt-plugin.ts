import { defineNuxtPlugin, useRuntimeConfig } from "#app";
import { defineAsyncComponent } from "vue";
import { createViteHubUI, type ViteHubUIOptions } from "../config.ts";

const viteHubUIPlugin: unknown = defineNuxtPlugin((nuxtApp) => {
  const options = useRuntimeConfig().public.viteHubUI as ViteHubUIOptions | undefined;
  // Nuxt renders icons through Nuxt Icon; createViteHubUI() keeps this registration.
  if (!nuxtApp.vueApp.component("UIcon")) nuxtApp.vueApp.component("UIcon", defineAsyncComponent(() => import("@nuxt/ui/components/Icon.vue")));
  nuxtApp.vueApp.use(createViteHubUI(options));
});

export default viteHubUIPlugin;
