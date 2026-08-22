import {
  DIFFS_TAG_NAME,
  FileDiff as PierreFileDiff,
  getSingularPatch,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  defineComponent,
  h,
  markRaw,
  onBeforeUnmount,
  type PropType,
  toRaw,
  type VNodeRef,
} from "vue";

export const PierreDiff = defineComponent({
  name: "ViteHubPierreDiff",
  inheritAttrs: false,
  props: {
    fileDiff: { type: Object as PropType<FileDiffMetadata> },
    options: { type: Object as PropType<FileDiffOptions<unknown>> },
    patch: { type: String },
    selectedLines: {
      default: undefined,
      type: Object as PropType<SelectedLineRange | null | undefined>,
    },
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreFileDiff<unknown> | undefined;
    const render = () => {
      if (!host) return;
      const fileDiff = props.fileDiff
        ? toRaw(props.fileDiff)
        : props.patch
          ? getSingularPatch(props.patch)
          : undefined;
      if (!fileDiff) {
        instance?.cleanUp();
        instance = undefined;
        return;
      }
      if (!instance) instance = markRaw(new PierreFileDiff(toRaw(props.options), undefined, true));
      instance.setOptions(toRaw(props.options));
      instance.render({ fileContainer: host, fileDiff, forceRender: true });
      if (props.selectedLines !== undefined) instance.setSelectedLines(toRaw(props.selectedLines));
    };
    const setHost = (node: Element | null) => {
      host = node instanceof HTMLElement ? node : null;
      render();
    };
    onBeforeUnmount(() => instance?.cleanUp());
    expose({ getInstance: () => instance });
    return () => {
      queueMicrotask(render);
      return h(DIFFS_TAG_NAME, { ...attrs, ref: setHost as VNodeRef });
    };
  },
});
