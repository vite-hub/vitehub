import type { App, ComputedRef, InjectionKey, Plugin } from "vue";
import { computed, inject } from "vue";
import { uiComponentsKey, type ViteHubUIComponents } from "./internal/nuxt-ui.ts";

export type { ViteHubUIComponentName, ViteHubUIComponents } from "./internal/nuxt-ui.ts";

export interface ViteHubUIDefaults {
  markdown?: { class?: string };
  messageScroller?: {
    edgeThreshold?: number;
    previousItemPeek?: number;
  };
}

/** Icons that the parts read from Nuxt UI's `appConfig.ui.icons`. In Nuxt, the module passes them for you. */
export interface ViteHubUIIconOptions {
  copy?: string;
  copyCheck?: string;
}

export interface ViteHubUIOptions {
  defaults?: ViteHubUIDefaults;
  /** Components that the parts render instead of Nuxt UI's, by name, such as `{ UIcon: MyIcon }`. */
  components?: ViteHubUIComponents;
  /** Icons by Nuxt UI name, such as `vitehubTheme.icons` from `@vite-hub/ui/theme`. Each one falls back to Lucide. */
  icons?: ViteHubUIIconOptions;
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
const iconsKey: InjectionKey<ViteHubUIIconOptions> = Symbol("ViteHubUIIcons");

const defaultIcons: Required<ViteHubUIIconOptions> = {
  copy: "i-lucide-copy",
  copyCheck: "i-lucide-check",
};

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

/** The icons that the parts render. It reads them on each render, so a reactive app config updates them. */
export function useViteHubUIIcons(): ComputedRef<Required<ViteHubUIIconOptions>> {
  const icons = inject(iconsKey, undefined);
  return computed(() => ({
    copy: icons?.copy || defaultIcons.copy,
    copyCheck: icons?.copyCheck || defaultIcons.copyCheck,
  }));
}

export function createViteHubUI(options: ViteHubUIOptions = {}): Plugin {
  return {
    install(app: App) {
      if (options.components) app.provide(uiComponentsKey, options.components);
      if (options.icons) app.provide(iconsKey, options.icons);
      app.provide(ViteHubUIInjectionKey, resolveViteHubUIDefaults(options));
    },
  };
}
