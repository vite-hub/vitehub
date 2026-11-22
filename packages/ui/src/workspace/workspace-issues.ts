import { defineComponent, h, type PropType } from "vue";

/**
 * A problem in the files, such as a parse error. `file` is the path of the file that it is in, and `line` the line of
 * that file, from 1.
 */
export interface WorkspaceIssue {
  message: string;
  file?: string;
  line?: number;
}

function where(issue: WorkspaceIssue): string | undefined {
  if (issue.file === undefined) return issue.line === undefined ? undefined : `Line ${issue.line}`;
  return issue.line === undefined ? issue.file : `${issue.file}:${issue.line}`;
}

/**
 * The issues of the last render, as a list. Screen readers hear each new list. Without issues the list hides, or shows
 * `empty` when it is set, such as in an Issues tab. An issue with a `file` shows `file:line` as a button that emits
 * `show` with the path.
 */
export const WorkspaceIssues = defineComponent({
  name: "WorkspaceIssues",
  props: {
    issues: { required: true, type: Array as PropType<readonly WorkspaceIssue[]> },
    /** The text to show when there are no issues. Without it, the list hides. */
    empty: { default: undefined, type: String },
  },
  emits: {
    show: (path: string) => typeof path === "string",
  },
  setup(props, { emit }) {
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
        : props.issues.map((issue) => {
            const label = where(issue);
            const file = issue.file;
            return h("li", [
              label === undefined
                ? undefined
                : file === undefined
                  ? h("span", { class: "vh-ws-issue-line" }, label)
                  : h("button", { class: "vh-ws-issue-line vh-ws-issue-file", title: `Open ${file}`, type: "button", onClick: () => emit("show", file) }, label),
              issue.message,
            ]);
          }));
    };
  },
});
