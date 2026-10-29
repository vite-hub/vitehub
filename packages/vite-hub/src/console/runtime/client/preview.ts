import { parseContentField } from "@vite-hub/content/client"

/**
 * The side browser of the document editor. The site renders the page of a document with its own routes: a draft view
 * posts a form with a token signed for that document and the version of it on screen to the page URL, and the
 * published view loads the page as guests do. The rest of the page reads published content. The frame is on the Console origin, so the editor reads the rendered page directly and never needs
 * messages from it.
 */

/** What the side browser shows: the draft on screen, or the page that guests see. */
export type ConsolePreviewView = "draft" | "published"
export type ConsolePreviewViewport = "desktop" | "mobile"

/** A document that the frame renders in place of its stored draft. */
export interface ConsolePreviewDocument {
  collection: string
  id: string
  data: Record<string, unknown>
  body?: string
}

/** The narrowest preview, in pixels, and the narrowest editor next to it. */
export const consolePreviewMinWidth = 320
export const consoleEditorMinWidth = 420
/** The phone viewport of the preview. */
export const consolePreviewMobileWidth = 390

/** The page URL of a document on this origin, or undefined when the page is elsewhere or has no URL. */
export function consolePreviewUrl(url: string | undefined, origin: string): URL | undefined {
  if (!url) return
  try {
    const parsed = new URL(url, origin)
    return parsed.origin === origin && (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed : undefined
  }
  catch {
    return undefined
  }
}

/** The form action of a draft view: the page URL with the preview parameter. The parameter alone grants nothing. */
export function consolePreviewFormAction(url: URL, parameter: string): string {
  const action = new URL(url)
  action.searchParams.set(parameter, "")
  return action.href
}

/** The form field value of a draft view: the token of one document and the version of it on screen. */
export function consolePreviewFormValue(token: string, document: ConsolePreviewDocument): string {
  return JSON.stringify({ token, document })
}

/**
 * The top-level field that an element of the rendered page shows, from its `contentField()` attribute, when it
 * belongs to the document in the editor. A nested path, such as `author.name`, selects its top-level field.
 */
export function consolePreviewField(value: string | null, collection: { name: string, kind: "documents" | "singleton" }, id: string): { field: string, nested: boolean } | undefined {
  if (value === null) return
  const address = parseContentField(value)
  if (!address || address.collection !== collection.name) return
  if (collection.kind === "documents" ? address.id !== id : address.id !== undefined && address.id !== id) return
  const [field] = address.field.split(".")
  return { field: field!, nested: address.field.includes(".") }
}

/** Clamps the preview width so both the preview and the editor keep their minimum widths. */
export function consolePreviewWidth(width: number, total: number): number {
  const maximum = Math.max(consolePreviewMinWidth, total - consoleEditorMinWidth)
  return Math.round(Math.min(Math.max(width, consolePreviewMinWidth), maximum))
}

/** One version of a document: its fields and its Markdown body. */
export interface ConsoleLocalVersion {
  body: string
  data: Record<string, unknown>
}

/**
 * Local-only edits of one document in one tab. They never save, autosave, or join the live room. `base` is the draft
 * digest they started from, so applying them refuses to overwrite a newer shared draft.
 */
export interface ConsoleLocalDraft {
  base: string | null
  start: ConsoleLocalVersion
  version: ConsoleLocalVersion
}

function localKey(collection: string, id: string): string {
  return `vitehub:console:local:${collection}/${id}`
}

function isVersion(value: unknown): value is ConsoleLocalVersion {
  if (!(value instanceof Object) || Array.isArray(value)) return false
  const body: unknown = Reflect.get(value, "body")
  const data: unknown = Reflect.get(value, "data")
  return String(body) === body && data instanceof Object && !Array.isArray(data)
}

/** Reads the local-only edits of a document in this tab. Anything that is not a local draft reads as none. */
export function readConsoleLocalDraft(storage: Pick<Storage, "getItem">, collection: string, id: string): ConsoleLocalDraft | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(storage.getItem(localKey(collection, id)) ?? "null")
  }
  catch {
    return
  }
  if (!(parsed instanceof Object) || Array.isArray(parsed)) return
  const base: unknown = Reflect.get(parsed, "base")
  const start: unknown = Reflect.get(parsed, "start")
  const version: unknown = Reflect.get(parsed, "version")
  if ((base !== null && String(base) !== base) || !isVersion(start) || !isVersion(version)) return
  return { base, start, version }
}

/** Keeps the local-only edits of a document in this tab, so a reload keeps them. Returns false when storage is full or off. */
export function writeConsoleLocalDraft(storage: Pick<Storage, "setItem">, collection: string, id: string, draft: ConsoleLocalDraft): boolean {
  try {
    storage.setItem(localKey(collection, id), JSON.stringify(draft))
    return true
  }
  catch {
    return false
  }
}

export function clearConsoleLocalDraft(storage: Pick<Storage, "removeItem">, collection: string, id: string): void {
  try {
    storage.removeItem(localKey(collection, id))
  }
  catch {
    // Storage that is off holds nothing to clear.
  }
}
