import { defineComponent, h, type PropType, type SlotsType, useId, type VNode } from "vue";
import { useUIComponent } from "../internal/nuxt-ui.ts";
import type { WorkspaceExample } from "./workspace-examples.ts";

/**
 * The start screen of a first visit: the examples as cards over the workspace, under the bar. A pick emits `pick` with
 * the id of the example. Show it only when the page opens without a share link, so a link opens its files at once.
 * Put it in the box of the bar, as `WorkspaceSidebar`.
 */
export const WorkspaceStart = defineComponent({
  name: "WorkspaceStart",
  props: {
    examples: { required: true, type: Array as PropType<readonly WorkspaceExample[]> },
    title: { default: "Start from an example", type: String },
    description: { default: "Each one runs in this tab. Edit it, then copy a link or download the files.", type: String },
  },
  emits: {
    pick: (id: string) => typeof id === "string",
  },
  slots: Object as SlotsType<{ footer?: () => VNode[] }>,
  setup(props, { emit, slots }) {
    const UIcon = useUIComponent("UIcon");
    const titleId = useId();
    const count = (files: WorkspaceExample["files"]) => {
      const length = files ? Object.keys(files).length : 0;
      return files ? h("span", { class: "vh-ws-start-files" }, length === 1 ? "1 file" : `${length} files`) : undefined;
    };
    return () => h("section", { "aria-labelledby": titleId, class: "vh-ws-start" }, h("div", { class: "vh-ws-start-content" }, [
      h("h2", { class: "vh-ws-start-title", id: titleId }, props.title),
      h("p", { class: "vh-ws-start-description" }, props.description),
      h("ul", { class: "vh-ws-start-grid" }, props.examples.map(example => h("li", { key: example.id }, h("button", {
        class: "vh-ws-start-card",
        type: "button",
        onClick: () => emit("pick", example.id),
      }, [
        h("span", { class: "vh-ws-start-label" }, example.label),
        example.description ? h("span", { class: "vh-ws-start-text" }, example.description) : undefined,
        count(example.files),
      ])))),
      h("div", { class: "vh-ws-start-foot" }, slots.footer?.() ?? [
        h(UIcon, { class: "vh-ws-icon", name: "i-lucide-link" }),
        "Opened from a share link? The files open at once, without this screen.",
      ]),
    ]));
  },
});
