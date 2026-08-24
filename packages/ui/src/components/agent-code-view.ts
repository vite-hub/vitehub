import type {
  CodeViewItem,
  CodeViewLineSelection,
  CodeViewOptions,
  DiffLineAnnotation,
  FileContents,
  FileDiffMetadata,
  FileDiffOptions,
  FileOptions,
  LineAnnotation,
  SelectedLineRange,
  UnresolvedFileOptions,
} from "@pierre/diffs";
import { defineComponent, h, type PropType } from "vue";
import {
  PierreCodeView,
  PierreDiff,
  PierreFile,
  PierreUnresolvedFile,
} from "../internal/pierre-code-view.ts";

const diffProps = {
  lineAnnotations: { type: Array as PropType<DiffLineAnnotation<unknown>[]> },
  options: { type: Object as PropType<FileDiffOptions<unknown>> },
  selectedLines: {
    default: undefined,
    type: Object as PropType<SelectedLineRange | null | undefined>,
  },
};

export const AgentPatchDiff = defineComponent({
  name: "AgentPatchDiff",
  inheritAttrs: false,
  props: {
    ...diffProps,
    patch: { required: true, type: String },
  },
  setup(props, { attrs }) {
    return () => h(PierreDiff, { ...attrs, ...props, class: ["vh-diff", attrs.class] });
  },
});

export const AgentMultiFileDiff = defineComponent({
  name: "AgentMultiFileDiff",
  inheritAttrs: false,
  props: {
    ...diffProps,
    newFile: { required: true, type: [Object, null] as PropType<FileContents | null> },
    oldFile: { required: true, type: [Object, null] as PropType<FileContents | null> },
  },
  setup(props, { attrs }) {
    return () => h(PierreDiff, { ...attrs, ...props, class: ["vh-diff", attrs.class] });
  },
});

export const AgentFileDiff = defineComponent({
  name: "AgentFileDiff",
  inheritAttrs: false,
  props: {
    ...diffProps,
    fileDiff: { required: true, type: Object as PropType<FileDiffMetadata> },
  },
  setup(props, { attrs }) {
    return () => h(PierreDiff, { ...attrs, ...props, class: ["vh-diff", attrs.class] });
  },
});

export const AgentFile = defineComponent({
  name: "AgentFile",
  inheritAttrs: false,
  props: {
    file: { required: true, type: Object as PropType<FileContents> },
    lineAnnotations: { type: Array as PropType<LineAnnotation<unknown>[]> },
    options: { type: Object as PropType<FileOptions<unknown>> },
    selectedLines: {
      default: undefined,
      type: Object as PropType<SelectedLineRange | null | undefined>,
    },
  },
  setup(props, { attrs }) {
    return () => h(PierreFile, { ...attrs, ...props, class: ["vh-file", attrs.class] });
  },
});

export const AgentUnresolvedFile = defineComponent({
  name: "AgentUnresolvedFile",
  inheritAttrs: false,
  props: {
    file: { required: true, type: Object as PropType<FileContents> },
    lineAnnotations: { type: Array as PropType<DiffLineAnnotation<unknown>[]> },
    options: { type: Object as PropType<UnresolvedFileOptions<unknown>> },
    selectedLines: {
      default: undefined,
      type: Object as PropType<SelectedLineRange | null | undefined>,
    },
  },
  setup(props, { attrs }) {
    return () =>
      h(PierreUnresolvedFile, {
        ...attrs,
        ...props,
        class: ["vh-unresolved-file", attrs.class],
      });
  },
});

export const AgentCodeView = defineComponent({
  name: "AgentCodeView",
  inheritAttrs: false,
  props: {
    items: { required: true, type: Array as PropType<readonly CodeViewItem<unknown>[]> },
    options: { type: Object as PropType<CodeViewOptions<unknown>> },
    selectedLines: {
      default: undefined,
      type: Object as PropType<CodeViewLineSelection | null | undefined>,
    },
  },
  setup(props, { attrs }) {
    return () => h(PierreCodeView, { ...attrs, ...props, class: ["vh-code-view", attrs.class] });
  },
});

export {
  getSingularPatch,
  parseDiffFromFile,
  parsePatchFiles,
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
