import comark from "@comark/vue/vite";
import nuxtUi from "@nuxt/ui/vite";
import type { PluginOption } from "vite";

export interface ViteHubUIViteOptions {
  comark?: false | { prose?: boolean };
  nuxtUI?: Record<string, unknown>;
}

export default function viteHubUI(options: ViteHubUIViteOptions = {}): PluginOption[] {
  return [
    nuxtUi(options.nuxtUI as Parameters<typeof nuxtUi>[0]),
    options.comark === false ? undefined : comark(options.comark),
  ].filter(Boolean) as PluginOption[];
}
