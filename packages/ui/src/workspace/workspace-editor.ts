import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CodeEditor } from "./codemirror.ts";

/** A CodeMirror 6 editor for one file. CodeMirror loads when the editor mounts, so it stays out of pages that do not show code. */
export const WorkspaceEditor = defineComponent({
  name: "WorkspaceEditor",
  props: {
    /** The file path. It picks the language. */
    path: { required: true, type: String },
    /** The file contents. Use `v-model`. */
    modelValue: { default: "", type: String },
    readonly: { default: false, type: Boolean },
  },
  emits: {
    "update:modelValue": (value: string) => typeof value === "string",
  },
  setup(props, { emit, expose }) {
    const host = ref<HTMLElement | null>(null);
    let editor: CodeEditor | undefined;
    let disposed = false;

    onMounted(async () => {
      const { createCodeEditor } = await import("./codemirror.ts");
      if (disposed || !host.value) return;
      host.value.replaceChildren();
      editor = createCodeEditor({
        doc: props.modelValue,
        onChange: value => emit("update:modelValue", value),
        parent: host.value,
        path: props.path,
        readonly: props.readonly,
      });
    });
    watch(() => [props.modelValue, props.path] as const, ([value, path]) => editor?.setDoc(value, path));
    watch(() => props.readonly, readonly => editor?.setReadonly(readonly));
    onBeforeUnmount(() => {
      disposed = true;
      editor?.destroy();
    });
    expose({ focus: () => editor?.focus() });

    // The plain text shows until CodeMirror loads, and during server rendering.
    return () => h("div", { class: "vh-ws-editor", "data-path": props.path, ref: host }, [
      h("pre", { class: "vh-ws-editor-fallback" }, props.modelValue),
    ]);
  },
});
