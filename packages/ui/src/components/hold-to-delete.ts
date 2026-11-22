import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref } from "vue";
import { createHoldToDelete, type HoldToDelete as HoldToDeleteController, type HoldToDeleteState } from "../motion/hold-to-delete.ts";

/**
 * A delete that can be undone, with hold to delete of `@vite-hub/ui/motion` (docs/design/motion.md, "Something is
 * deleted and the delete can be undone"). Hold the button: it fills, and a release before the end cancels. At the end it
 * emits `delete`, so hide the item, the item leaves toward the trash, and the button turns into Undo. `commit` runs the
 * real delete once the Undo window passes. Undo emits `undo`, so show the item again.
 *
 * Use it only where the real delete can wait: a delete in the browser, or an API whose delete the page may send a few
 * seconds later. Unmounting it during the Undo window, or leaving the page, commits.
 */
export const HoldToDelete = defineComponent({
  name: "HoldToDelete",
  props: {
    commit: { required: true, type: Function as PropType<() => void | Promise<void>> },
    item: { default: undefined, type: Function as PropType<() => Element | null | undefined> },
    label: { default: "Hold to delete", type: String },
    undoLabel: { default: "Undo", type: String },
    undoFor: { default: 5000, type: Number },
    confirm: { default: undefined, type: Function as PropType<() => boolean | Promise<boolean>> },
  },
  emits: {
    delete: () => true,
    undo: () => true,
    error: (_error: unknown) => true,
    state: (_state: HoldToDeleteState) => true,
  },
  setup(props, { emit, expose }) {
    const root = ref<HTMLButtonElement>();
    let hold: HoldToDeleteController | undefined;
    onMounted(() => {
      if (!root.value) return;
      hold = createHoldToDelete(root.value, {
        commit: () => props.commit(),
        confirm: props.confirm ? () => props.confirm!() : undefined,
        item: () => props.item?.(),
        label: props.label,
        onDelete: () => emit("delete"),
        onError: error => emit("error", error),
        onState: state => emit("state", state),
        onUndo: () => emit("undo"),
        undoFor: props.undoFor,
        undoLabel: props.undoLabel,
      });
    });
    onBeforeUnmount(() => hold?.destroy());
    expose({ undo: () => hold?.undo() });
    return () => h("button", { "data-icon-only": props.label ? undefined : "", "data-slot": "hold-to-delete", ref: root, type: "button" });
  },
});
