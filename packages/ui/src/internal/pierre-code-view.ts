import {
  CodeView as PierreCodeViewModel,
  DIFFS_TAG_NAME,
  File as PierreFileModel,
  FileDiff as PierreFileDiffModel,
  getSingularPatch,
  parseDiffFromFile,
  UnresolvedFile as PierreUnresolvedFileModel,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type FileDiffOptions,
  type FileOptions,
  type LineAnnotation,
  type SelectedLineRange,
  type UnresolvedFileOptions,
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

const selectedLinesProp = {
  default: undefined,
  type: Object as PropType<SelectedLineRange | null | undefined>,
};

export const PierreDiff = defineComponent({
  name: "ViteHubPierreDiff",
  inheritAttrs: false,
  props: {
    fileDiff: { type: Object as PropType<FileDiffMetadata> },
    lineAnnotations: { type: Array as PropType<DiffLineAnnotation<unknown>[]> },
    newFile: { type: [Object, null] as PropType<FileContents | null> },
    oldFile: { type: [Object, null] as PropType<FileContents | null> },
    options: { type: Object as PropType<FileDiffOptions<unknown>> },
    patch: { type: String },
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreFileDiffModel<unknown> | undefined;
    let parsedPatch: { patch: string; fileDiff: FileDiffMetadata } | undefined;
    let parsedFiles:
      | {
          fileDiff: FileDiffMetadata;
          newFile: FileContents | null;
          oldFile: FileContents | null;
          parseDiffOptions: FileDiffOptions<unknown>["parseDiffOptions"];
        }
      | undefined;

    const getFileDiff = (): FileDiffMetadata | undefined => {
      if (props.fileDiff) return toRaw(props.fileDiff);
      if (props.patch !== undefined) {
        if (parsedPatch?.patch !== props.patch) {
          parsedPatch = { fileDiff: getSingularPatch(props.patch), patch: props.patch };
        }
        return parsedPatch.fileDiff;
      }
      if (props.oldFile !== undefined && props.newFile !== undefined) {
        const oldFile = toRaw(props.oldFile);
        const newFile = toRaw(props.newFile);
        const parseDiffOptions = toRaw(props.options?.parseDiffOptions);
        if (
          parsedFiles?.oldFile !== oldFile ||
          parsedFiles.newFile !== newFile ||
          parsedFiles.parseDiffOptions !== parseDiffOptions
        ) {
          parsedFiles = {
            fileDiff: parseDiffFromFile(oldFile, newFile, parseDiffOptions),
            newFile,
            oldFile,
            parseDiffOptions,
          };
        }
        return parsedFiles.fileDiff;
      }
    };

    const render = () => {
      if (!host) return;
      const fileDiff = getFileDiff();
      if (!fileDiff) {
        instance?.cleanUp();
        instance = undefined;
        return;
      }
      if (!instance) instance = markRaw(new PierreFileDiffModel(toRaw(props.options), undefined, true));
      instance.setOptions(toRaw(props.options));
      instance.render({
        fileContainer: host,
        fileDiff,
        forceRender: true,
        lineAnnotations: toRaw(props.lineAnnotations),
      });
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

export const PierreFile = defineComponent({
  name: "ViteHubPierreFile",
  inheritAttrs: false,
  props: {
    file: { type: Object as PropType<FileContents> },
    lineAnnotations: { type: Array as PropType<LineAnnotation<unknown>[]> },
    options: { type: Object as PropType<FileOptions<unknown>> },
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreFileModel<unknown> | undefined;
    const render = () => {
      if (!host) return;
      if (!props.file) {
        instance?.cleanUp();
        instance = undefined;
        return;
      }
      if (!instance) instance = markRaw(new PierreFileModel(toRaw(props.options), undefined, true));
      instance.setOptions(toRaw(props.options));
      instance.render({
        file: toRaw(props.file),
        fileContainer: host,
        forceRender: true,
        lineAnnotations: toRaw(props.lineAnnotations),
      });
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

export const PierreUnresolvedFile = defineComponent({
  name: "ViteHubPierreUnresolvedFile",
  inheritAttrs: false,
  props: {
    file: { type: Object as PropType<FileContents> },
    lineAnnotations: { type: Array as PropType<DiffLineAnnotation<unknown>[]> },
    options: { type: Object as PropType<UnresolvedFileOptions<unknown>> },
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreUnresolvedFileModel<unknown> | undefined;
    const render = () => {
      if (!host) return;
      if (!props.file) {
        instance?.cleanUp();
        instance = undefined;
        return;
      }
      if (!instance) {
        instance = markRaw(new PierreUnresolvedFileModel(toRaw(props.options), undefined, true));
      }
      instance.setOptions(toRaw(props.options));
      instance.render({
        file: toRaw(props.file),
        fileContainer: host,
        forceRender: true,
        lineAnnotations: toRaw(props.lineAnnotations),
      });
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

export const PierreCodeView = defineComponent({
  name: "ViteHubPierreCodeView",
  inheritAttrs: false,
  props: {
    items: { required: true, type: Array as PropType<readonly CodeViewItem<unknown>[]> },
    options: { type: Object as PropType<CodeViewOptions<unknown>> },
    selectedLines: {
      default: undefined,
      type: Object as PropType<CodeViewLineSelection | null | undefined>,
    },
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreCodeViewModel<unknown> | undefined;
    const render = () => {
      if (!host) return;
      if (!instance) {
        instance = markRaw(new PierreCodeViewModel(toRaw(props.options), undefined, true));
        instance.setup(host);
      }
      instance.setOptions(toRaw(props.options));
      instance.setItems(toRaw(props.items));
      if (props.selectedLines !== undefined) {
        instance.setSelectedLines(toRaw(props.selectedLines), { notify: false });
      }
      instance.render(true);
    };
    const setHost = (node: Element | null) => {
      host = node instanceof HTMLElement ? node : null;
      render();
    };
    onBeforeUnmount(() => instance?.cleanUp());
    expose({ getInstance: () => instance });
    return () => {
      queueMicrotask(render);
      return h("div", { ...attrs, ref: setHost as VNodeRef });
    };
  },
});
