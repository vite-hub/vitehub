import { findContentEntry } from "@vite-hub/source/vite"

import type { ViteHubConsoleDocumentEditorSection } from "@vite-hub/internal/console"

export interface ContentConsoleOptions {
  projectRoot: string
  /** Server directories to search, relative to `projectRoot`. Defaults to `server`. */
  serverDirs?: string[]
}

/**
 * Console section for Content. It edits the document collections of the `content` export of `server/content.ts`.
 * Every action checks `content.can()` with the signed-in Console user. The Console shows the section only when the
 * project has a Content file.
 */
export const contentConsoleSection: ViteHubConsoleDocumentEditorSection<ContentConsoleOptions> = {
  actions: { export: "createContentConsoleActions", module: "@vite-hub/content/runtime/console" },
  description: "Edit, publish, and restore Content documents.",
  entry: options => findContentEntry(options),
  icon: "i-lucide-file-pen-line",
  id: "content",
  label: "Content",
  view: {
    kind: "document-editor",
    notice: "Saves commit to the draft ref of the Content Workspace. Publishing copies documents to the published ref, which /api/content serves. content.can() decides what each user may read, write, and publish.",
  },
}
