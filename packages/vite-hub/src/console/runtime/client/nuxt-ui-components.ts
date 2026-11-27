import type { ViteHubUIComponents } from "@vite-hub/ui";
import { type Component, defineAsyncComponent } from "vue";

function lazy(loader: () => Promise<{ default: Component }>): Component {
  return defineAsyncComponent({ loader, suspensible: false });
}

/**
 * The Console renders the `@vite-hub/ui` parts with Nuxt UI until it moves to ui-sdk (vite-hub/vitehub#5258). They load
 * on first render, as the parts' own defaults do. `UIcon` is Nuxt UI's Vue icon, because Nuxt UI's Vite plugin swaps it
 * in only for imports inside Nuxt UI.
 */
export const consoleNuxtUIComponents: ViteHubUIComponents = {
  UButton: lazy(() => import("@nuxt/ui/components/Button.vue")),
  UDropdownMenu: lazy(() => import("@nuxt/ui/components/DropdownMenu.vue")),
  UEditorDragHandle: lazy(() => import("@nuxt/ui/components/EditorDragHandle.vue")),
  UEditorSuggestionMenu: lazy(() => import("@nuxt/ui/components/EditorSuggestionMenu.vue")),
  UEditorToolbar: lazy(() => import("@nuxt/ui/components/EditorToolbar.vue")),
  UIcon: lazy(() => import("@nuxt/ui/runtime/vue/components/Icon.vue")),
  UInput: lazy(() => import("@nuxt/ui/components/Input.vue")),
  UModal: lazy(() => import("@nuxt/ui/components/Modal.vue")),
  UTabs: lazy(() => import("@nuxt/ui/components/Tabs.vue")),
  UTooltip: lazy(() => import("@nuxt/ui/components/Tooltip.vue")),
};
