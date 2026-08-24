import { defineComponent, h } from "vue";
import {
  PierreCodeView,
  PierreDiff,
  PierreFile,
  PierreUnresolvedFile,
  pierrePropTypes,
} from "../internal/pierre-code-view.ts";

const diffProps = {
  lineAnnotations: { type: pierrePropTypes.diffLineAnnotations },
  options: { type: pierrePropTypes.fileDiffOptions },
  selectedLines: {
    default: undefined,
    type: pierrePropTypes.selectedLines,
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
    newFile: { required: true, type: pierrePropTypes.nullableFileContents },
    oldFile: { required: true, type: pierrePropTypes.nullableFileContents },
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
    fileDiff: { required: true, type: pierrePropTypes.fileDiff },
  },
  setup(props, { attrs }) {
    return () => h(PierreDiff, { ...attrs, ...props, class: ["vh-diff", attrs.class] });
  },
});

export const AgentFile = defineComponent({
  name: "AgentFile",
  inheritAttrs: false,
  props: {
    file: { required: true, type: pierrePropTypes.fileContents },
    lineAnnotations: { type: pierrePropTypes.lineAnnotations },
    options: { type: pierrePropTypes.fileOptions },
    selectedLines: {
      default: undefined,
      type: pierrePropTypes.selectedLines,
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
    file: { required: true, type: pierrePropTypes.fileContents },
    lineAnnotations: { type: pierrePropTypes.diffLineAnnotations },
    options: { type: pierrePropTypes.unresolvedFileOptions },
    selectedLines: {
      default: undefined,
      type: pierrePropTypes.selectedLines,
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
    items: { required: true, type: pierrePropTypes.codeViewItems },
    options: { type: pierrePropTypes.codeViewOptions },
    selectedLines: {
      default: undefined,
      type: pierrePropTypes.codeViewSelection,
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
