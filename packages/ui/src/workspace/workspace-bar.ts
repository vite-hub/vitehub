import { defineComponent, h, type SlotsType, type VNode } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";

/**
 * The 44px bar over a workspace. From the start: the sidebar button (when `sidebar` is set), the `lead` slot (such as a
 * logo and a title), the `examples` slot (a `WorkspaceExamples`), the step label, the default slot (such as the run
 * state), a spacer, and the `actions` slot. Inside the `bar` slot of `WorkspaceShell` it takes the border and the
 * height of the shell.
 */
export const WorkspaceBar = defineComponent({
  name: "WorkspaceBar",
  props: {
    sidebar: { default: undefined, type: Boolean },
    sidebarId: { default: undefined, type: String },
    step: { default: undefined, type: String },
  },
  emits: {
    "update:sidebar": (open: boolean) => typeof open === "boolean",
  },
  slots: Object as SlotsType<{ lead?: () => VNode[], examples?: () => VNode[], default?: () => VNode[], actions?: () => VNode[] }>,
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    return () => h("header", { class: "vh-ws-topbar" }, [
      props.sidebar === undefined
        ? undefined
        : h(UButton, {
            "aria-controls": props.sidebarId,
            "aria-expanded": String(props.sidebar),
            "aria-label": props.sidebar ? "Close the sidebar" : "Open the sidebar",
            class: "vh-ws-bar-button vh-ws-bar-icon",
            color: "neutral",
            icon: "i-lucide-panel-left",
            variant: "ghost",
            onClick: () => emit("update:sidebar", !props.sidebar),
          }),
      slots.lead?.(),
      slots.examples?.(),
      props.step ? h("span", { class: "vh-ws-step" }, props.step) : undefined,
      slots.default?.(),
      h("span", { class: "vh-ws-spacer" }),
      slots.actions?.(),
    ]);
  },
});
