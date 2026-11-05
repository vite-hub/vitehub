import { docsSectionForPath, findDocsPage, normalizeDocsPath } from "./navigation.ts"
import { docsPageOf, docsPageResponse } from "./page.ts"
import { docsFrontmatter, docsPageSchema } from "./schema.ts"

import type { DocsDocument } from "./markdown.ts"
import type { DocsPageResponse } from "./page.ts"
import type { DocsManifest, DocsPage } from "./types.ts"

/** One document as a Content collection reads it. */
export interface DocsContentDocument {
  id: string
  data: Record<string, unknown>
  body?: string
  url?: string | null
}

/** What the page route reads from the app's `content` export of `server/content.ts`. */
export interface DocsContentRuntime {
  preview: {
    /** True when a preview cookie makes Content reads use the `draft` ref. */
    active(): boolean
    /** The one document that a Console preview frame shows, or undefined outside a frame. */
    frame(): { collection: string, id: string } | undefined
  }
  resolve(path: string): Promise<{ collection: string, id: string } | null>
  collection(name: string): { get(id: string): Promise<DocsContentDocument | null> }
}

/**
 * The draft of the page at `path`, parsed like a published page, or null when the request shows the published file.
 * A preview frame shows the draft of its one document, also before the page is published. A preview cookie shows the
 * draft that Content resolves for the URL.
 */
export async function docsDraftResponse(
  content: DocsContentRuntime,
  manifest: DocsManifest,
  path: string,
  parse: (markdown: string) => Promise<DocsDocument>,
): Promise<DocsPageResponse | null> {
  const normalized = normalizeDocsPath(path)
  const draft = await readDraft(content, normalized)
  if (!draft) return null
  const published = findDocsPage(manifest, normalized)
  const section = published?.section ?? (normalized === manifest.root?.path ? null : docsSectionForPath(manifest, normalized))
  const result = docsPageSchema.safeParse(docsFrontmatter(draft.data))
  // A draft whose fields do not validate yet shows its body under the published title.
  const at = { id: published?.page.id ?? pageId(manifest, normalized, section?.path), path: normalized, file: `${draft.id}.md` }
  const page: DocsPage | undefined = result.success ? docsPageOf(result.data, at) : published?.page
  if (!page) return null
  return docsPageResponse(manifest, { page, section }, await parse(draft.body ?? ""), page.credits ? await parse(page.credits) : null)
}

async function readDraft(content: DocsContentRuntime, path: string): Promise<DocsContentDocument | null> {
  const frame = content.preview.frame()
  if (frame) {
    const document = await content.collection(frame.collection).get(frame.id)
    // The frame signs one document. Other pages that the frame page loads stay published.
    return typeof document?.url === "string" && normalizeDocsPath(document.url) === path ? document : null
  }
  const found = await content.resolve(path)
  return found ? await content.collection(found.collection).get(found.id) : null
}

/** The id that the manifest gives a page at `path`: its path inside its section, `index` for an overview or the root. */
function pageId(manifest: DocsManifest, path: string, section: string | undefined): string {
  if (path === manifest.root?.path) return "index"
  if (!section) return ""
  return path === section ? "index" : path.slice(section.length + 1)
}
