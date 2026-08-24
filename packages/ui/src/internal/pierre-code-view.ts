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
  computed,
  defineComponent,
  h,
  onBeforeUnmount,
  type PropType,
  toRaw,
  type VNodeRef,
  watchEffect,
} from "vue";

export const pierrePropTypes = {
  // SAFETY: Vue validates the array container; Pierre validates each item while rendering.
  codeViewItems: Array as PropType<readonly CodeViewItem<unknown>[]>,
  // SAFETY: Vue validates the object container; Pierre owns the options schema.
  codeViewOptions: Object as PropType<CodeViewOptions<unknown>>,
  // SAFETY: Vue validates the object container; Pierre owns the selection schema.
  codeViewSelection: Object as PropType<CodeViewLineSelection | null | undefined>,
  // SAFETY: Vue validates the array container; Pierre owns the annotation schema.
  diffLineAnnotations: Array as PropType<DiffLineAnnotation<unknown>[]>,
  // SAFETY: Vue validates the object container; Pierre owns the file schema.
  fileContents: Object as PropType<FileContents>,
  // SAFETY: Vue validates the object container; Pierre owns the parsed diff schema.
  fileDiff: Object as PropType<FileDiffMetadata>,
  // SAFETY: Vue validates the object container; Pierre owns the options schema.
  fileDiffOptions: Object as PropType<FileDiffOptions<unknown>>,
  // SAFETY: Vue validates the object container; Pierre owns the options schema.
  fileOptions: Object as PropType<FileOptions<unknown>>,
  // SAFETY: Vue validates the array container; Pierre owns the annotation schema.
  lineAnnotations: Array as PropType<LineAnnotation<unknown>[]>,
  // SAFETY: Vue accepts an object or null; Pierre owns the file schema.
  nullableFileContents: [Object, null] as PropType<FileContents | null>,
  // SAFETY: Vue validates the object container; Pierre owns the selection schema.
  selectedLines: Object as PropType<SelectedLineRange | null | undefined>,
  // SAFETY: Vue validates the object container; Pierre owns the options schema.
  unresolvedFileOptions: Object as PropType<UnresolvedFileOptions<unknown>>,
};

const selectedLinesProp = {
  default: undefined,
  type: pierrePropTypes.selectedLines,
};

function controlledOptions<T extends { controlledSelection?: boolean }>(
  options: T | undefined,
  selectedLines: unknown,
) {
  const rawOptions = trackShallow(options);
  return selectedLines === undefined ? rawOptions : { ...rawOptions, controlledSelection: true };
}

function trackShallow<T>(value: T): T {
  const objectValue = Object(value);
  if (!Object.is(objectValue, value)) return toRaw(value);
  for (const key of Reflect.ownKeys(objectValue)) Reflect.get(objectValue, key);
  return toRaw(value);
}

function trackArrayItems<T extends readonly unknown[] | undefined>(values: T): T {
  if (!values) return values;
  for (const value of values) trackShallow(value);
  return toRaw(values);
}

function copyFile(file: FileContents | null): FileContents | null {
  return file === null ? null : { ...file };
}

function copyParseDiffOptions(options: FileDiffOptions<unknown>["parseDiffOptions"]) {
  if (!options) return;
  return {
    ...options,
    headerOptions: options.headerOptions ? { ...options.headerOptions } : undefined,
  };
}

export const PierreDiff = defineComponent({
  name: "ViteHubPierreDiff",
  inheritAttrs: false,
  props: {
    fileDiff: { type: pierrePropTypes.fileDiff },
    lineAnnotations: { type: pierrePropTypes.diffLineAnnotations },
    newFile: { type: pierrePropTypes.nullableFileContents },
    oldFile: { type: pierrePropTypes.nullableFileContents },
    options: { type: pierrePropTypes.fileDiffOptions },
    patch: { type: String },
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreFileDiffModel<unknown> | undefined;
    const fileDiff = computed<FileDiffMetadata | undefined>(() => {
      if (props.fileDiff) return trackShallow(props.fileDiff);
      if (props.patch !== undefined) return getSingularPatch(props.patch);
      if (props.oldFile !== undefined && props.newFile !== undefined) {
        return parseDiffFromFile(
          copyFile(props.oldFile),
          copyFile(props.newFile),
          copyParseDiffOptions(props.options?.parseDiffOptions),
        );
      }
    });

    const render = () => {
      if (!host) return;
      if (!fileDiff.value) {
        instance?.cleanUp();
        instance = undefined;
        return;
      }
      const options = controlledOptions(props.options, props.selectedLines);
      if (!instance) instance = new PierreFileDiffModel(options, undefined, true);
      instance.setOptions(options);
      instance.render({
        fileContainer: host,
        fileDiff: fileDiff.value,
        forceRender: true,
        lineAnnotations: trackArrayItems(props.lineAnnotations) ?? [],
      });
      if (props.selectedLines !== undefined) instance.setSelectedLines(trackShallow(props.selectedLines));
    };
    const setHost: VNodeRef = (node) => {
      host = node instanceof HTMLElement ? node : null;
    };
    watchEffect(render, { flush: "post" });
    onBeforeUnmount(() => instance?.cleanUp());
    expose({ getInstance: () => instance });
    return () => h(DIFFS_TAG_NAME, { ...attrs, ref: setHost });
  },
});

export const PierreFile = defineComponent({
  name: "ViteHubPierreFile",
  inheritAttrs: false,
  props: {
    file: { type: pierrePropTypes.fileContents },
    lineAnnotations: { type: pierrePropTypes.lineAnnotations },
    options: { type: pierrePropTypes.fileOptions },
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreFileModel<unknown> | undefined;
    const file = computed(() => (props.file ? copyFile(props.file) : undefined));
    const render = () => {
      if (!host) return;
      if (!file.value) {
        instance?.cleanUp();
        instance = undefined;
        return;
      }
      const options = controlledOptions(props.options, props.selectedLines);
      if (!instance) instance = new PierreFileModel(options, undefined, true);
      instance.setOptions(options);
      instance.render({
        file: file.value,
        fileContainer: host,
        forceRender: true,
        lineAnnotations: trackArrayItems(props.lineAnnotations) ?? [],
      });
      if (props.selectedLines !== undefined) instance.setSelectedLines(trackShallow(props.selectedLines));
    };
    const setHost: VNodeRef = (node) => {
      host = node instanceof HTMLElement ? node : null;
    };
    watchEffect(render, { flush: "post" });
    onBeforeUnmount(() => instance?.cleanUp());
    expose({ getInstance: () => instance });
    return () => h(DIFFS_TAG_NAME, { ...attrs, ref: setHost });
  },
});

export const PierreUnresolvedFile = defineComponent({
  name: "ViteHubPierreUnresolvedFile",
  inheritAttrs: false,
  props: {
    file: { type: pierrePropTypes.fileContents },
    lineAnnotations: { type: pierrePropTypes.diffLineAnnotations },
    options: { type: pierrePropTypes.unresolvedFileOptions },
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreUnresolvedFileModel<unknown> | undefined;
    let renderedFile: FileContents | undefined;
    const file = computed(() => (props.file ? copyFile(props.file) : undefined));
    const render = () => {
      if (!host) return;
      if (!file.value) {
        instance?.cleanUp();
        instance = undefined;
        renderedFile = undefined;
        return;
      }
      if (instance && renderedFile !== file.value) {
        instance.cleanUp();
        instance = undefined;
      }
      const options = controlledOptions(props.options, props.selectedLines);
      if (!instance) instance = new PierreUnresolvedFileModel(options, undefined, true);
      instance.setOptions(options);
      instance.render({
        file: file.value,
        fileContainer: host,
        forceRender: true,
        lineAnnotations: trackArrayItems(props.lineAnnotations) ?? [],
      });
      renderedFile = file.value;
      if (props.selectedLines !== undefined) instance.setSelectedLines(trackShallow(props.selectedLines));
    };
    const setHost: VNodeRef = (node) => {
      host = node instanceof HTMLElement ? node : null;
    };
    watchEffect(render, { flush: "post" });
    onBeforeUnmount(() => instance?.cleanUp());
    expose({ getInstance: () => instance });
    return () => h(DIFFS_TAG_NAME, { ...attrs, ref: setHost });
  },
});

export const PierreCodeView = defineComponent({
  name: "ViteHubPierreCodeView",
  inheritAttrs: false,
  props: {
    items: { required: true, type: pierrePropTypes.codeViewItems },
    options: { type: pierrePropTypes.codeViewOptions },
    selectedLines: {
      default: undefined,
      type: pierrePropTypes.codeViewSelection,
    },
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreCodeViewModel<unknown> | undefined;
    const render = () => {
      if (!host) return;
      const options = controlledOptions(props.options, props.selectedLines);
      if (!instance) {
        instance = new PierreCodeViewModel(options, undefined, true);
        instance.setup(host);
      }
      instance.setOptions(options);
      instance.setItems(trackArrayItems(props.items)!);
      if (props.selectedLines !== undefined) {
        instance.setSelectedLines(trackShallow(props.selectedLines), { notify: false });
      }
      instance.render(true);
    };
    const setHost: VNodeRef = (node) => {
      host = node instanceof HTMLElement ? node : null;
    };
    watchEffect(render, { flush: "post" });
    onBeforeUnmount(() => instance?.cleanUp());
    expose({ getInstance: () => instance });
    return () => h("div", { ...attrs, ref: setHost });
  },
});
