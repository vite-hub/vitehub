import comark from "@comark/vue/vite";
import type { Plugin, PluginOption } from "vite";

export interface ViteHubUIViteOptions {
  comark?: false | { prose?: boolean };
}

function asPluginOption(plugin: unknown): PluginOption {
  // SAFETY: Comark returns a Vite plugin, but its transitive Vite type identity can differ from this package's resolved Vite version.
  return plugin as PluginOption;
}

export default function viteHubUI(options: ViteHubUIViteOptions = {}): PluginOption[] {
  const treeshakeUI: Plugin = {
    name: "vite-hub:ui:lazy-barrel",
    apply: "build",
    config(config) {
      if (config.build?.rolldownOptions?.experimental?.lazyBarrel !== undefined) return;
      return { build: { rolldownOptions: { experimental: { lazyBarrel: true } } } };
    },
  };

  return [
    treeshakeUI,
    options.comark === false ? undefined : asPluginOption(comark(options.comark)),
  ].filter((plugin): plugin is PluginOption => plugin !== undefined);
}
