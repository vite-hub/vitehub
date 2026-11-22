import { defineComponent, h, onBeforeUnmount, onMounted, ref, type SlotsType, type VNodeChild } from "vue";
import { createDropField, type DropField as DropFieldController } from "../motion/drop-field.ts";

export interface DropFieldSlots {
  /** The text of the field. `over` is true while a file is over it. */
  default?: (props: { over: boolean }) => VNodeChild;
}

/**
 * A place to drop files, with the drop field of `@vite-hub/ui/motion` (docs/design/motion.md, "Files are dragged in"):
 * a grid of dots that leans toward the dragged file. It is a label around a native file input, so a click and the
 * keyboard open the file picker as before. It emits `files` for a drop and for a pick.
 */
export const DropField = defineComponent({
  name: "DropField",
  props: {
    accept: { default: undefined, type: String },
    multiple: { default: false, type: Boolean },
    disabled: { default: false, type: Boolean },
    label: { default: "Drop files to upload", type: String },
    description: { default: "or click to browse", type: String },
  },
  emits: {
    files: (files: File[]) => Array.isArray(files),
  },
  // SAFETY: Vue uses Object as its runtime slots marker.
  slots: Object as SlotsType<DropFieldSlots>,
  setup(props, { emit, slots }) {
    const root = ref<HTMLElement>();
    const over = ref(false);
    let field: DropFieldController | undefined;
    const watcher = typeof MutationObserver === "function" ? new MutationObserver(() => (over.value = root.value?.dataset.over !== undefined)) : undefined;
    onMounted(() => {
      if (!root.value) return;
      field = createDropField(root.value, {
        accepts: event => !props.disabled && [...event.dataTransfer?.types ?? []].includes("Files"),
        onFiles: (files) => {
          if (files.length) emit("files", props.multiple ? files : files.slice(0, 1));
        },
      });
      watcher?.observe(root.value, { attributeFilter: ["data-over"] });
    });
    onBeforeUnmount(() => {
      watcher?.disconnect();
      field?.destroy();
    });
    function pick(event: Event) {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      const files = [...input.files ?? []];
      input.value = "";
      if (files.length) emit("files", files);
    }
    return () => h("label", { "data-disabled": props.disabled ? "" : undefined, "data-focus-ring": "", "data-slot": "drop-field", ref: root }, [
      h("input", { accept: props.accept, "data-slot": "drop-field-input", disabled: props.disabled, multiple: props.multiple, onChange: pick, type: "file" }),
      slots.default?.({ over: over.value }) ?? [
        h("span", { "data-slot": "drop-field-label" }, over.value ? "Release to upload" : props.label),
        props.description ? h("span", { "data-slot": "drop-field-description" }, props.description) : null,
      ],
    ]);
  },
});
