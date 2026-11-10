import {
  CodeView as PierreCodeViewModel,
  DIFFS_TAG_NAME,
  File as PierreFileModel,
  FileDiff as PierreFileDiffModel,
  getSingularPatch,
  parseDiffFromFile,
  UnresolvedFile as PierreUnresolvedFileModel,
  type FileContents,
  type FileDiffMetadata,
  type FileDiffOptions,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  computed,
  defineComponent,
  h,
  onBeforeUnmount,
  toRaw,
  type VNodeRef,
  watchEffect,
} from "vue";
import { pierrePropTypes } from "./pierre-props.ts";

const selectedLinesProp = {
  default: undefined,
  type: pierrePropTypes.selectedLines,
};

const scrollToSelectedLinesProp = { default: false, type: Boolean };

/**
 * Centers `row` in the nearest ancestor of the view that scrolls, else in the page. `scrollIntoView` alone also moves
 * each `overflow: hidden` ancestor, such as an app shell.
 */
function scrollToRow(host: HTMLElement, row: HTMLElement) {
  let scroller: HTMLElement | null = host;
  while (
    scroller &&
    !(/auto|scroll|overlay/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)
  )
    scroller = scroller.parentElement;
  if (!scroller || scroller === document.body || scroller === document.documentElement) {
    row.scrollIntoView({ block: "center", inline: "nearest" });
    return;
  }
  const rect = row.getBoundingClientRect();
  scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - (scroller.clientHeight - rect.height) / 2;
}

/**
 * Scrolls the first selected line into view, once for each new range or `source`. Pierre marks the selected rows in a
 * later frame and renders the file after its highlighter loads, so this waits for the row of the new selection.
 */
function createSelectionScroll(getHost: () => HTMLElement | null) {
  let key: readonly unknown[] | undefined;
  let observer: MutationObserver | undefined;
  const stop = () => {
    observer?.disconnect();
    observer = undefined;
  };
  const sync = (range: SelectedLineRange | null | undefined, source: readonly unknown[]) => {
    const next = range ? [...source, ...rangeKey(range)] : undefined;
    const previous = key;
    const host = getHost();
    const root = host?.shadowRoot;
    key = root ? next : undefined;
    if (next && previous?.length === next.length && next.every((value, index) => Object.is(value, previous[index])))
      return;
    stop();
    if (!range || !host || !root) return;
    const scroll = () => {
      const row = root.querySelector<HTMLElement>(
        '[data-line][data-selected-line="first"], [data-line][data-selected-line="single"]',
      );
      const line = Number(row?.dataset.line);
      // A row of the selection before this one stays marked until Pierre's next frame.
      if (!row || (line !== range.start && line !== range.end)) return;
      stop();
      scrollToRow(host, row);
    };
    observer = new MutationObserver(scroll);
    observer.observe(root, {
      attributeFilter: ["data-selected-line"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    scroll();
  };
  return { stop, sync };
}

function rangeKey(range: SelectedLineRange) {
  return [range.start, range.end, range.side, range.endSide];
}

function controlledOptions<T extends { controlledSelection?: boolean }>(
  options: T | undefined,
  selectedLines: unknown,
) {
  const rawOptions = trackShallow(options);
  return selectedLines === undefined ? rawOptions : { ...rawOptions, controlledSelection: true };
}

function accessibleOptions<
  T extends { controlledSelection?: boolean; enableLineSelection?: boolean },
>(options: T | undefined, selectedLines: unknown) {
  return {
    ...controlledOptions(options, selectedLines),
    enableLineSelection: false,
  };
}

function accessibleDiffOptions(
  options: FileDiffOptions<unknown, unknown> | undefined,
  selectedLines: unknown,
  fileDiff: FileDiffMetadata,
): FileDiffOptions<unknown, unknown> {
  const expandUnchanged = !fileDiff.isPartial || options?.loadDiffFiles !== undefined;
  return {
    ...accessibleOptions(options, selectedLines),
    expandUnchanged,
    ...(!expandUnchanged && { hunkSeparators: "metadata" }),
  };
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

function copyParseDiffOptions(options: FileDiffOptions<unknown, unknown>["parseDiffOptions"]) {
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
    scrollToSelectedLines: scrollToSelectedLinesProp,
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreFileDiffModel<unknown> | undefined;
    const selectionScroll = createSelectionScroll(() => host);
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
      const options = accessibleDiffOptions(props.options, props.selectedLines, fileDiff.value);
      if (!instance) instance = new PierreFileDiffModel(options, undefined, true);
      instance.setOptions(options);
      instance.render({
        fileContainer: host,
        fileDiff: fileDiff.value,
        forceRender: true,
        lineAnnotations: trackArrayItems(props.lineAnnotations) ?? [],
      });
      if (props.selectedLines !== undefined)
        instance.setSelectedLines(trackShallow(props.selectedLines));
      selectionScroll.sync(props.scrollToSelectedLines ? props.selectedLines : undefined, [
        toRaw(props.fileDiff),
        props.patch,
        props.oldFile?.name,
        props.oldFile?.contents,
        props.newFile?.name,
        props.newFile?.contents,
      ]);
    };
    const setHost: VNodeRef = (node) => {
      host = node instanceof HTMLElement ? node : null;
    };
    watchEffect(render, { flush: "post" });
    onBeforeUnmount(() => {
      selectionScroll.stop();
      instance?.cleanUp();
    });
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
    scrollToSelectedLines: scrollToSelectedLinesProp,
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreFileModel<unknown> | undefined;
    const selectionScroll = createSelectionScroll(() => host);
    const file = computed(() => (props.file ? copyFile(props.file) : undefined));
    const render = () => {
      if (!host) return;
      if (!file.value) {
        instance?.cleanUp();
        instance = undefined;
        return;
      }
      const options = accessibleOptions(props.options, props.selectedLines);
      if (!instance) instance = new PierreFileModel(options, undefined, true);
      instance.setOptions(options);
      instance.render({
        file: file.value,
        fileContainer: host,
        forceRender: true,
        lineAnnotations: trackArrayItems(props.lineAnnotations) ?? [],
      });
      if (props.selectedLines !== undefined)
        instance.setSelectedLines(trackShallow(props.selectedLines));
      selectionScroll.sync(props.scrollToSelectedLines ? props.selectedLines : undefined, [
        file.value.name,
        file.value.contents,
      ]);
    };
    const setHost: VNodeRef = (node) => {
      host = node instanceof HTMLElement ? node : null;
    };
    watchEffect(render, { flush: "post" });
    onBeforeUnmount(() => {
      selectionScroll.stop();
      instance?.cleanUp();
    });
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
    scrollToSelectedLines: scrollToSelectedLinesProp,
    selectedLines: selectedLinesProp,
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreUnresolvedFileModel<unknown> | undefined;
    const selectionScroll = createSelectionScroll(() => host);
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
      const options = accessibleOptions(props.options, props.selectedLines);
      if (!instance) instance = new PierreUnresolvedFileModel(options, undefined, true);
      instance.setOptions(options);
      instance.render({
        file: file.value,
        fileContainer: host,
        forceRender: true,
        lineAnnotations: trackArrayItems(props.lineAnnotations) ?? [],
      });
      renderedFile = file.value;
      if (props.selectedLines !== undefined)
        instance.setSelectedLines(trackShallow(props.selectedLines));
      selectionScroll.sync(props.scrollToSelectedLines ? props.selectedLines : undefined, [
        file.value.name,
        file.value.contents,
      ]);
    };
    const setHost: VNodeRef = (node) => {
      host = node instanceof HTMLElement ? node : null;
    };
    watchEffect(render, { flush: "post" });
    onBeforeUnmount(() => {
      selectionScroll.stop();
      instance?.cleanUp();
    });
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
    scrollToSelectedLines: scrollToSelectedLinesProp,
    selectedLines: {
      default: undefined,
      type: pierrePropTypes.codeViewSelection,
    },
  },
  setup(props, { attrs, expose }) {
    let host: HTMLElement | null = null;
    let instance: PierreCodeViewModel<unknown> | undefined;
    let scrolledTo: readonly unknown[] | undefined;
    const render = () => {
      if (!host) return;
      const options = accessibleOptions(props.options, props.selectedLines);
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
      const selection = props.scrollToSelectedLines ? props.selectedLines : undefined;
      const key = selection ? [selection.id, ...rangeKey(selection.range)] : undefined;
      const changed = key?.some((value, index) => value !== scrolledTo?.[index]);
      scrolledTo = key;
      // The list renders only the rows in view, so Pierre finds the place of the lines.
      if (selection && changed)
        instance.scrollTo({ align: "center", id: selection.id, range: selection.range, type: "range" });
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
