import type { App, InjectionKey, Plugin } from "vue";
import { defineAsyncComponent, inject } from "vue";

export interface ViteHubUIDefaults {
  markdown?: { class?: string };
  messageScroller?: {
    edgeThreshold?: number;
    previousItemPeek?: number;
  };
}

export interface ViteHubUIOptions {
  defaults?: ViteHubUIDefaults;
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

const runtimeComponents = {
  UBadge: defineAsyncComponent(() => import("@nuxt/ui/components/Badge.vue")),
  UButton: defineAsyncComponent(() => import("@nuxt/ui/components/Button.vue")),
  UChatMessage: defineAsyncComponent(() => import("@nuxt/ui/components/ChatMessage.vue")),
  UChatPrompt: defineAsyncComponent(() => import("@nuxt/ui/components/ChatPrompt.vue")),
  UChatPromptSubmit: defineAsyncComponent(
    () => import("@nuxt/ui/components/ChatPromptSubmit.vue"),
  ),
  UChatReasoning: defineAsyncComponent(() => import("@nuxt/ui/components/ChatReasoning.vue")),
  UChatTool: defineAsyncComponent(() => import("@nuxt/ui/components/ChatTool.vue")),
  UCollapsible: defineAsyncComponent(() => import("@nuxt/ui/components/Collapsible.vue")),
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
      for (const [name, component] of Object.entries(runtimeComponents)) {
        if (!app.component(name)) app.component(name, component);
      }
      app.provide(ViteHubUIInjectionKey, resolveViteHubUIDefaults(options));
    },
  };
}
