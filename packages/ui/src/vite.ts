import comark from "@comark/vue/vite";
import nuxtUi from "@nuxt/ui/vite";
import type { PluginOption } from "vite";

export interface ViteHubUIViteOptions {
  comark?: false | { prose?: boolean };
  nuxtUI?: Record<string, unknown>;
}

function asPluginOption(plugin: unknown): PluginOption {
  // SAFETY: Both integrations return Vite plugins, but their transitive Vite type identities can differ from this package's resolved Vite version.
  return plugin as PluginOption;
}

export default function viteHubUI(options: ViteHubUIViteOptions = {}): PluginOption[] {
  // SAFETY: The public options record is the open configuration object accepted by Nuxt UI's Vite integration.
  const nuxtUIOptions = options.nuxtUI as Parameters<typeof nuxtUi>[0];
  const nuxtUIPlugin = asPluginOption(nuxtUi(nuxtUIOptions));

  return [
    nuxtUIPlugin,
    options.comark === false ? undefined : asPluginOption(comark(options.comark)),
  ].filter((plugin): plugin is PluginOption => plugin !== undefined);
}
