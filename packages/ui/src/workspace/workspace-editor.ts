import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CodeEditor } from "./codemirror.ts";
import type { WorkspaceCursor } from "./workspace-status.ts";

/** A CodeMirror 6 editor for one file. CodeMirror loads when the editor mounts, so it stays out of pages that do not show code. */
export const WorkspaceEditor = defineComponent({
  name: "WorkspaceEditor",
  props: {
    /** The file path. It picks the language. */
    path: { required: true, type: String },
    /** The file contents. Use `v-model`. */
    modelValue: { default: "", type: String },
    readonly: { default: false, type: Boolean },
    /** Whether long lines wrap. Use `v-model:wrap`: Alt+Z toggles it, as in VS Code. */
    wrap: { default: false, type: Boolean },
  },
  emits: {
    "update:modelValue": (value: string) => typeof value === "string",
    "update:wrap": (wrap: boolean) => typeof wrap === "boolean",
    /** The cursor moved. Give it to `WorkspaceStatus`. */
    cursor: (cursor: WorkspaceCursor) => typeof cursor.line === "number",
  },
  setup(props, { emit, expose }) {
    const host = ref<HTMLElement | null>(null);
    // Alt+Z works without `v-model:wrap` too: the editor keeps its own state, and a bound value replaces it.
    const wrap = ref(props.wrap);
    let editor: CodeEditor | undefined;
    let disposed = false;

    function setWrap(next: boolean) {
      wrap.value = next;
      emit("update:wrap", next);
    }

    onMounted(async () => {
      const { createCodeEditor } = await import("./codemirror.ts");
      if (disposed || !host.value) return;
      host.value.replaceChildren();
      editor = createCodeEditor({
        doc: props.modelValue,
        onChange: value => emit("update:modelValue", value),
        onCursor: cursor => emit("cursor", cursor),
        onToggleWrap: () => setWrap(!wrap.value),
        parent: host.value,
        path: props.path,
        readonly: props.readonly,
        wrap: wrap.value,
      });
    });
    watch(() => [props.modelValue, props.path] as const, ([value, path]) => editor?.setDoc(value, path));
    watch(() => props.readonly, readonly => editor?.setReadonly(readonly));
    watch(() => props.wrap, (next) => { wrap.value = next; });
    watch(wrap, next => editor?.setWrap(next));
    onBeforeUnmount(() => {
      disposed = true;
      editor?.destroy();
    });
    expose({ focus: () => editor?.focus(), toggleWrap: () => setWrap(!wrap.value) });

    // The plain text shows until CodeMirror loads, and during server rendering.
    return () => h("div", { class: "vh-ws-editor", "data-path": props.path, "data-wrap": wrap.value ? "" : undefined, ref: host }, [
      h("pre", { class: "vh-ws-editor-fallback" }, props.modelValue),
    ]);
  },
});
