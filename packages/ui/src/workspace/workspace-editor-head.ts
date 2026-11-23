import { defineComponent, h } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import { fileIcon } from "./file-icons.ts";
import { icon } from "./icons.ts";

/**
 * The row over the editor: the path of the open file as a breadcrumb, a "Read-only" mark for a file that the reader
 * cannot edit, and a button that wraps long lines. Put it in the `editor-head` slot of `WorkspaceShell`, which makes the
 * row 32px high, as high as the tab bar of the output.
 */
export const WorkspaceEditorHead = defineComponent({
  name: "WorkspaceEditorHead",
  props: {
    /** The path of the open file, such as `src/components/Greeting.vue`. */
    path: { required: true, type: String },
    readonly: { default: false, type: Boolean },
    /** Whether the editor wraps long lines. Use `v-model:wrap`, and give the same value to `WorkspaceEditor`. */
    wrap: { default: false, type: Boolean },
  },
  emits: {
    "update:wrap": (wrap: boolean) => typeof wrap === "boolean",
  },
  setup(props, { emit, slots }) {
    const UButton = useUIComponent("UButton");
    return () => {
      const folders = props.path.split("/").filter(Boolean);
      const name = folders.pop() ?? props.path;
      return h("div", { class: "vh-ws-file-head" }, [
        h("nav", { "aria-label": "File path", class: "vh-ws-breadcrumb", title: props.path }, [
          ...folders.flatMap(folder => [h("span", folder), icon("chevron-right", "vh-ws-breadcrumb-separator")]),
          fileIcon(name),
          h("b", name),
        ]),
        props.readonly ? h("span", { class: "vh-ws-readonly" }, [icon("lock", "vh-ws-readonly-icon"), "Read-only"]) : undefined,
        h("span", { class: "vh-ws-file-head-spacer" }),
        slots.default?.(),
        h(UButton, {
          "aria-keyshortcuts": "Alt+Z",
          "aria-label": "Wrap lines",
          "aria-pressed": props.wrap ? "true" : "false",
          class: "vh-ws-wrap-button",
          color: "neutral",
          icon: "i-lucide-text-wrap",
          size: "xs",
          square: true,
          title: "Wrap lines (Alt+Z)",
          variant: "ghost",
          onClick: () => emit("update:wrap", !props.wrap),
        }),
      ]);
    };
  },
});
