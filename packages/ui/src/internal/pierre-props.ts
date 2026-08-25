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
import type { PropType } from "vue";

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
