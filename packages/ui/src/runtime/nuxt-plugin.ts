import { defineNuxtPlugin, useAppConfig, useRuntimeConfig, useState } from "#app";
import { defineAsyncComponent } from "vue";
import { provideRelativeNow } from "../components/relative-time.ts";
import { createViteHubUI, type ViteHubUIIconOptions, type ViteHubUIOptions } from "../config.ts";
import { startRelativeClock } from "../internal/relative-now.ts";

const viteHubUIPlugin: unknown = defineNuxtPlugin((nuxtApp) => {
  const options = useRuntimeConfig().public.viteHubUI as ViteHubUIOptions | undefined;
  // In Nuxt, icons come from the @nuxt/icon bundle through Nuxt UI's Nuxt icon. The parts default to the Vue one.
  const UIcon = defineAsyncComponent(() => import("@nuxt/ui/components/Icon.vue"));
  // The parts take their icons from Nuxt UI's `appConfig.ui.icons`, as Nuxt UI's own components do, and the names that
  // Nuxt UI does not have from `appConfig.viteHubUI.icons`. The getter keeps them reactive.
  const appConfig = useAppConfig();
  const icons = () => ({ ...iconsIn(appConfig, "ui"), ...iconsIn(appConfig, "viteHubUI") });
  nuxtApp.vueApp.use(createViteHubUI({ ...options, components: { UIcon }, icons }));
  // The clock of `RelativeTime`: the request time, sent in the payload so the browser hydrates the same words, then
  // the browser clock once the page has hydrated.
  const now = useState("vite-hub-ui:now", () => Date.now());
  provideRelativeNow(now, nuxtApp.vueApp);
  if (import.meta.client) nuxtApp.hooks.hookOnce("app:suspense:resolve", () => void startRelativeClock(now));
});

function iconsIn(appConfig: object, key: string): ViteHubUIIconOptions | undefined {
  const config: unknown = Reflect.get(appConfig, key);
  if (typeof config !== "object" || config === null || !("icons" in config)) return undefined;
  const icons: unknown = config.icons;
  return typeof icons === "object" && icons !== null ? icons : undefined;
}

export default viteHubUIPlugin;
