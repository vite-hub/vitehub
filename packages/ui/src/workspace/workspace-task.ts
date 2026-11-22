import { defineComponent, h } from "vue";

/** The task of a step: what the reader does next, in a box under the step's text. */
export const WorkspaceTask = defineComponent({
  name: "WorkspaceTask",
  props: {
    /** The heading of the box. */
    title: { default: "Try it", type: String },
  },
  setup(props, { slots }) {
    return () => h("div", { class: "vh-ws-task", role: "note" }, [
      h("p", { class: "vh-ws-task-title" }, slots.title?.() ?? props.title),
      h("div", { class: "vh-ws-task-body" }, slots.default?.()),
    ]);
  },
});
