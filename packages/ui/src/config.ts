import type { App, InjectionKey, Plugin } from "vue";
import { inject } from "vue";
import { uiComponentsKey, type ViteHubUIComponents } from "./internal/nuxt-ui.ts";

export type { ViteHubUIComponentName, ViteHubUIComponents } from "./internal/nuxt-ui.ts";

export interface ViteHubUIDefaults {
  markdown?: { class?: string };
  messageScroller?: {
    edgeThreshold?: number;
    previousItemPeek?: number;
  };
}

export interface ViteHubUIOptions {
  defaults?: ViteHubUIDefaults;
  /** Components that the parts render instead of Nuxt UI's, by name, such as `{ UIcon: MyIcon }`. */
  components?: ViteHubUIComponents;
}

export interface ResolvedViteHubUIDefaults {
  markdown: { class: string };
  messageScroller: {
    edgeThreshold: number;
    previousItemPeek: number;
  };
}

const defaultOptions: ResolvedViteHubUIDefaults = {
  markdown: { class: "vh-typeset vh-typeset-chat" },
  messageScroller: { edgeThreshold: 8, previousItemPeek: 64 },
};

export const ViteHubUIInjectionKey: InjectionKey<ResolvedViteHubUIDefaults> = Symbol("ViteHubUI");

export function resolveViteHubUIDefaults(
  options: ViteHubUIOptions = {},
): ResolvedViteHubUIDefaults {
  return {
    markdown: { ...defaultOptions.markdown, ...options.defaults?.markdown },
    messageScroller: { ...defaultOptions.messageScroller, ...options.defaults?.messageScroller },
  };
}

export function useViteHubUI(): ResolvedViteHubUIDefaults {
  return inject(ViteHubUIInjectionKey, defaultOptions);
}

export function createViteHubUI(options: ViteHubUIOptions = {}): Plugin {
  return {
    install(app: App) {
      if (options.components) app.provide(uiComponentsKey, options.components);
      app.provide(ViteHubUIInjectionKey, resolveViteHubUIDefaults(options));
    },
  };
}
