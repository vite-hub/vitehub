import { type Component, defineAsyncComponent, getCurrentInstance, inject, type InjectionKey } from "vue";

/** The Nuxt UI components that the styled parts render. */
export type ViteHubUIComponentName = "UBadge" | "UButton" | "UChatReasoning" | "UChatTool" | "UCollapsible" | "UIcon" | "UInput" | "UModal";

/** Components that replace the Nuxt UI ones in the parts, by name. Give them to `createViteHubUI({ components })`. */
export type ViteHubUIComponents = Partial<Record<ViteHubUIComponentName, Component>>;

export const uiComponentsKey: InjectionKey<ViteHubUIComponents> = Symbol("ViteHubUIComponents");

// The parts import Nuxt UI themselves, so they do not depend on how the app registers it: Nuxt imports Nuxt UI into
// each template, and a Vue app may not register it at all. They load on first render, so an entry that never renders a
// part never loads Nuxt UI.
const bundled: Record<ViteHubUIComponentName, Component> = {
  UBadge: defineAsyncComponent(() => import("@nuxt/ui/components/Badge.vue")),
  UButton: defineAsyncComponent(() => import("@nuxt/ui/components/Button.vue")),
  UChatReasoning: defineAsyncComponent(() => import("@nuxt/ui/components/ChatReasoning.vue")),
  UChatTool: defineAsyncComponent(() => import("@nuxt/ui/components/ChatTool.vue")),
  UCollapsible: defineAsyncComponent(() => import("@nuxt/ui/components/Collapsible.vue")),
  // Nuxt UI's Vite plugin swaps in its Vue icon only for imports inside Nuxt UI, so import the Vue one here. The Nuxt
  // plugin of this package provides Nuxt UI's Nuxt icon, which reads the @nuxt/icon bundle.
  UIcon: defineAsyncComponent(() => import("@nuxt/ui/runtime/vue/components/Icon.vue")),
  UInput: defineAsyncComponent(() => import("@nuxt/ui/components/Input.vue")),
  UModal: defineAsyncComponent(() => import("@nuxt/ui/components/Modal.vue")),
};

/**
 * The component that a part renders for `name`: the one given to `createViteHubUI({ components })`, else one that the
 * app registered globally under that name, such as a stand-in of a page without Nuxt UI, else Nuxt UI's own. Call it in
 * `setup()`.
 */
export function useUIComponent(name: ViteHubUIComponentName): Component {
  return inject(uiComponentsKey, undefined)?.[name] ?? getCurrentInstance()?.appContext.components[name] ?? bundled[name];
}
