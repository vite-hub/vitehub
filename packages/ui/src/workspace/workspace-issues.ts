import { defineComponent, h, type PropType } from "vue";

/** A problem in the files, such as a parse error. `line` is the line of the file, from 1. */
export interface WorkspaceIssue {
  message: string;
  line?: number;
}

/**
 * The issues of the last render, as a list. Screen readers hear each new list. Without issues the list hides, or shows
 * `empty` when it is set, such as in an Issues tab.
 */
export const WorkspaceIssues = defineComponent({
  name: "WorkspaceIssues",
  props: {
    issues: { required: true, type: Array as PropType<readonly WorkspaceIssue[]> },
    /** The text to show when there are no issues. Without it, the list hides. */
    empty: { default: undefined, type: String },
  },
  setup(props) {
    return () => {
      const none = props.issues.length === 0;
      return h("ul", {
        "aria-label": "Issues",
        "aria-live": "polite",
        class: "vh-ws-issues",
        "data-empty": none ? "" : undefined,
        hidden: none && !props.empty,
      }, none
        ? props.empty ? [h("li", { class: "vh-ws-issues-empty" }, props.empty)] : []
        : props.issues.map(issue => h("li", [
            issue.line === undefined ? undefined : h("span", { class: "vh-ws-issue-line" }, `Line ${issue.line}`),
            issue.message,
          ])));
    };
  },
});
