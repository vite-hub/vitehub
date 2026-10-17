import { findContentEntry, inspectContentEntry } from "@vite-hub/source/vite"

import type { ViteHubConsoleDocumentEditorSection } from "@vite-hub/internal/console"

export interface ContentConsoleOptions {
  projectRoot: string
  /** Server directories to search, relative to `projectRoot`. Defaults to `server`. */
  serverDirs?: string[]
}

/**
 * Finds the Content module of the project, but only when it may define document collections. Discovery reads the
 * `defineContent()` call without running it; anything it cannot follow, such as options imported from another file,
 * counts as maybe.
 */
async function findContentCollectionsEntry(options: ContentConsoleOptions): Promise<string | undefined> {
  const file = await findContentEntry(options)
  if (!file) return
  return (await inspectContentEntry(file)).collections ? file : undefined
}

/**
 * Console section for Content. It edits the document collections of the `content` export of `server/content.ts`.
 * Every action checks `content.can()` with the signed-in Console user. The Console shows the section only when
 * `defineContent()` defines document collections; a Content file with only read-only Sources has nothing to edit.
 */
export const contentConsoleSection: ViteHubConsoleDocumentEditorSection<ContentConsoleOptions> = {
  actions: { export: "createContentConsoleActions", module: "@vite-hub/content/runtime/console" },
  description: "Edit, publish, and restore Content documents.",
  entry: options => findContentCollectionsEntry(options),
  icon: "i-lucide-file-pen-line",
  id: "content",
  label: "Content",
  pages: [
    { id: "dashboard", label: "Dashboard", icon: "i-lucide-layout-dashboard", index: true, view: { kind: "document-dashboard" } },
    { id: "settings", label: "Settings", icon: "i-lucide-settings-2", group: "Site", view: { kind: "document-settings" } },
    { id: "media", label: "Media", icon: "i-lucide-image", group: "Assets", requires: ["blob"], view: { kind: "media-library" } },
  ],
  view: {
    kind: "document-editor",
    notice: "Saves commit to the draft ref of the Content Workspace. Publishing copies documents to the published ref, which /api/content serves. content.can() decides what each user may read, write, and publish.",
  },
}
