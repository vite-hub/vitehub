import { defineComponent, h, onBeforeUnmount, onMounted, type PropType, ref, watch } from "vue";
import { createProgress, type Progress as ProgressController } from "../motion/progress.ts";

/**
 * The progress of work that runs, such as an upload, a deploy, or a sync, with the progress helper of
 * `@vite-hub/ui/motion` (docs/design/motion.md, "Work runs"). A `value` from 0 to 1 fills the bar with a head at its
 * end, `null` shows a wave while work runs with no known total, and `done` draws a dot into a check.
 */
export const Progress = defineComponent({
  name: "Progress",
  props: {
    value: { default: undefined, type: Number as PropType<number | null> },
    done: { default: false, type: Boolean },
    label: { default: undefined, type: String },
  },
  setup(props) {
    const root = ref<HTMLElement>();
    let progress: ProgressController | undefined;
    function apply() {
      if (!progress) return;
      if (props.done) progress.done();
      else if (props.value === undefined) progress.reset();
      else progress.set(props.value);
    }
    onMounted(() => {
      if (!root.value) return;
      progress = createProgress(root.value);
      apply();
    });
    watch(() => [props.value, props.done], apply);
    onBeforeUnmount(() => progress?.destroy());
    const now = () => (props.done ? 100 : typeof props.value === "number" ? Math.round(Math.max(0, Math.min(1, props.value)) * 100) : undefined);
    return () => h("div", {
      ref: root,
      "aria-label": props.label,
      "aria-valuemax": 100,
      "aria-valuemin": 0,
      "aria-valuenow": now(),
      "data-slot": "progress",
      role: "progressbar",
    });
  },
});
