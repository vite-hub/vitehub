import { defineComponent, h, inject, type InjectionKey, provide } from "vue";

/** What a file link asks of the workspace that holds it. */
export interface WorkspaceFileOpener {
  /** Opens `path` in the editor. A path that does not exist yet can open as a new, empty file. */
  show: (path: string) => void;
}

const fileOpenerKey: InjectionKey<WorkspaceFileOpener> = Symbol("WorkspaceFileOpener");

/**
 * Lets the file links under this component open files. A workspace calls it with its own `show`. A page that puts the
 * guide outside the workspace calls it too, in the component that holds both.
 */
export function provideWorkspaceFileOpener(opener: WorkspaceFileOpener): void {
  provide(fileOpenerKey, opener);
}

/**
 * An inline link in a guide that opens a file in the workspace editor. It shows the file name, or its slot. It calls
 * the opener of `provideWorkspaceFileOpener()` above it, and emits `open` either way.
 */
export const WorkspaceFileLink = defineComponent({
  name: "WorkspaceFileLink",
  props: {
    /** The path of the file in the workspace, such as `src/app.vue`. */
    path: { required: true, type: String },
  },
  emits: {
    open: (path: string) => typeof path === "string",
  },
  setup(props, { emit, slots }) {
    const opener = inject(fileOpenerKey, undefined);
    return () => h("button", {
      class: "vh-ws-file-link",
      "data-path": props.path,
      title: `Open ${props.path}`,
      type: "button",
      onClick: () => {
        opener?.show(props.path);
        emit("open", props.path);
      },
    }, slots.default?.() ?? props.path.split("/").pop());
  },
});
