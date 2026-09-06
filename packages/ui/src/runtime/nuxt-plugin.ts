import { defineNuxtPlugin, useRuntimeConfig } from "#app";
import { createViteHubUI, type ViteHubUIOptions } from "../config.ts";

const viteHubUIPlugin: unknown = defineNuxtPlugin((nuxtApp) => {
  const options = useRuntimeConfig().public.viteHubUI as ViteHubUIOptions | undefined;
  nuxtApp.vueApp.use(createViteHubUI(options));
});

export default viteHubUIPlugin;
