import { type Component, defineAsyncComponent, getCurrentInstance, inject, type InjectionKey } from "vue";

/** The components that the styled parts render, by their Nuxt UI names. */
export type ViteHubUIComponentName =
  | "UButton"
  | "UDropdownMenu"
  | "UEditorDragHandle"
  | "UEditorSuggestionMenu"
  | "UEditorToolbar"
  | "UIcon"
  | "UInput"
  | "UModal"
  | "UTabs"
  | "UTooltip";

/** Components that replace the default ones in the parts, by name. Give them to `createViteHubUI({ components })`. */
export type ViteHubUIComponents = Partial<Record<ViteHubUIComponentName, Component>>;

/** The names that the ui-sdk set has a component for. Without a tooltip, a part uses the `title` attribute. */
export type ViteHubUIDefaultComponentName = Exclude<ViteHubUIComponentName, "UTooltip">;

export const uiComponentsKey: InjectionKey<ViteHubUIComponents> = Symbol("ViteHubUIComponents");

// The defaults are the ui-sdk set. It loads on first render, so an entry that never renders a part never loads ui-sdk.
function fromSet(name: ViteHubUIDefaultComponentName): Component {
  return defineAsyncComponent({ loader: () => import("../ui-sdk/components.ts").then(set => set.uiSdkComponents[name]), suspensible: false });
}

const defaults: Record<ViteHubUIDefaultComponentName, Component> = {
  UButton: fromSet("UButton"),
  UDropdownMenu: fromSet("UDropdownMenu"),
  UEditorDragHandle: fromSet("UEditorDragHandle"),
  UEditorSuggestionMenu: fromSet("UEditorSuggestionMenu"),
  UEditorToolbar: fromSet("UEditorToolbar"),
  UIcon: fromSet("UIcon"),
  UInput: fromSet("UInput"),
  UModal: fromSet("UModal"),
  UTabs: fromSet("UTabs"),
};

function own(name: ViteHubUIComponentName): Component | undefined {
  return inject(uiComponentsKey, undefined)?.[name] ?? getCurrentInstance()?.appContext.components[name];
}

/**
 * The component that a part renders for `name`: the one given to `createViteHubUI({ components })`, else one that the
 * app registered globally under that name, such as a stand-in of a page in a shadow root, else the ui-sdk one. Call it
 * in `setup()`.
 */
export function useUIComponent(name: ViteHubUIDefaultComponentName): Component {
  return own(name) ?? defaults[name];
}

/**
 * The tooltip that a part renders: the one given to `createViteHubUI({ components })` or registered globally. Without
 * one, the part uses the `title` attribute. Call it in `setup()`.
 */
export function useTooltipComponent(): Component | undefined {
  return own("UTooltip");
}
