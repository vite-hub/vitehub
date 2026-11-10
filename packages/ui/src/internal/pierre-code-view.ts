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

// Pierre can keep the previous source rendered while a replacement's highlighter loads.
class SelectionFileModel extends PierreFileModel<unknown> {
  isSourceRendered() {
    const file = this.getLatestFile();
    const rendered = this.getRenderedFile();
    if (!file || !rendered) return false;
    if (file.cacheKey != null || rendered.cacheKey != null) return file.cacheKey === rendered.cacheKey;
    return file.name === rendered.name && file.contents === rendered.contents && file.lang === rendered.lang;
  }
}

class SelectionDiffModel extends PierreFileDiffModel<unknown> {
  isSourceRendered() {
    return sameDiffSource(this.getLatestDiff(), this.getRenderedDiff());
  }
}

class SelectionUnresolvedFileModel extends PierreUnresolvedFileModel<unknown> {
  isSourceRendered() {
    return sameDiffSource(this.getLatestDiff(), this.getRenderedDiff());
  }
}

function sameDiffSource(diff: FileDiffMetadata | undefined, rendered: FileDiffMetadata | undefined) {
  return diff === rendered || (diff?.cacheKey != null && diff.cacheKey === rendered?.cacheKey);
}

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
function createSelectionScroll(getHost: () => HTMLElement | null, isSourceRendered: () => boolean) {
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
      if (!isSourceRendered()) return;
      const rows = root.querySelectorAll<HTMLElement>(
        '[data-line][data-selected-line="first"], [data-line][data-selected-line="single"]',
      );
      const row = Array.from(rows).find((row) => {
        const line = Number(row.dataset.line);
        const side = row.closest("[data-deletions]") || row.dataset.lineType === "change-deletion" ? "deletions"
          : row.closest("[data-additions]") || row.dataset.lineType === "change-addition" ? "additions" : undefined;
        return (line === range.start && (!side || side === (range.side ?? "additions")))
          || (line === range.end && (!side || side === (range.endSide ?? range.side ?? "additions")));
      });
      if (!row) return;
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
    let instance: SelectionDiffModel | undefined;
    const selectionScroll = createSelectionScroll(() => host, () => instance?.isSourceRendered() ?? false);
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
      if (!instance) instance = new SelectionDiffModel(options, undefined, true);
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
    let instance: SelectionFileModel | undefined;
    const selectionScroll = createSelectionScroll(() => host, () => instance?.isSourceRendered() ?? false);
    const file = computed(() => (props.file ? copyFile(props.file) : undefined));
    const render = () => {
      if (!host) return;
      if (!file.value) {
        instance?.cleanUp();
        instance = undefined;
        return;
      }
      const options = accessibleOptions(props.options, props.selectedLines);
      if (!instance) instance = new SelectionFileModel(options, undefined, true);
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
    let instance: SelectionUnresolvedFileModel | undefined;
    const selectionScroll = createSelectionScroll(() => host, () => instance?.isSourceRendered() ?? false);
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
      if (!instance) instance = new SelectionUnresolvedFileModel(options, undefined, true);
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
