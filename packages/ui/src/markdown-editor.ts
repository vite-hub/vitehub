// Outside the root barrel, so pages that only render Markdown never load Tiptap.
export { blobUpload, MarkdownEditor, type MarkdownEditorUpload } from "./components/markdown-editor.ts";
export {
  createEditorHandlers,
  type EditorHandler,
  type EditorHandlers,
  editorHandlersKey,
  type EditorItem,
  type EditorMenuEntry,
  mapEditorItems,
  type MappedEditorMenuEntry,
} from "./editor/handlers.ts";
export type { EditorDragHandleNode, EditorSuggestionMenuItem, EditorToolbarItem, EditorToolbarMenuEntry, EditorToolbarTooltip } from "./ui-sdk/editor.ts";
