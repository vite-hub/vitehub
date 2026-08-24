import type { FileDiffMetadata, FileDiffOptions, SelectedLineRange } from "@pierre/diffs";
import { computed, defineComponent, h, type PropType } from "vue";
import { PierreDiff } from "../internal/pierre-diff.ts";

export const AgentDiff = defineComponent({
  name: "AgentDiff",
  inheritAttrs: false,
  props: {
    fileDiff: { type: Object as PropType<FileDiffMetadata> },
    options: { type: Object as PropType<Omit<FileDiffOptions<unknown>, "enableLineSelection" | "expandUnchanged">> },
    patch: { type: String },
    selectedLines: {
      default: undefined,
      type: Object as PropType<SelectedLineRange | null | undefined>,
    },
  },
  setup(props, { attrs }) {
    const options = computed(() => ({
      ...props.options,
      enableLineSelection: false,
      expandUnchanged: true,
    }));

    return () =>
      h(PierreDiff, {
        ...attrs,
        class: ["vh-diff", attrs.class],
        fileDiff: props.fileDiff,
        options: options.value,
        patch: props.patch,
        selectedLines: props.selectedLines,
      });
  },
});
