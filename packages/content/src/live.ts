/**
 * Content live editing, as installed by generated host output when a Realtime authority serves the Content Realtime
 * Definition. The slot is process-wide, so the Content runtime, its Console actions, and the generated Nitro plugin
 * share it without importing each other.
 */
export interface ContentLiveInstall {
  /** The Realtime Definition that serves Content documents, such as `content`. Rooms are `<collection>/<id>`. */
  definition: string
  /** Tells the open room of a document that a write outside the room changed it. */
  refresh: (documentId: string) => Promise<unknown>
}

const liveKey: unique symbol = Symbol.for("vitehub.content.live")
// SAFETY: This module owns the process slot shared by separately bundled generated plugins and the Content runtime.
const scope = globalThis as typeof globalThis & { [liveKey]?: ContentLiveInstall }

/** Install Content live editing for this process. Generated host output calls it; applications do not. */
export function installContentLive(install: ContentLiveInstall): void {
  if (install === null || Object(install) !== install || String(install.definition) !== install.definition || !install.definition || !(install.refresh instanceof Function)) {
    throw new TypeError("[vitehub] installContentLive() requires { definition, refresh }.")
  }
  scope[liveKey] = Object.freeze({ definition: install.definition, refresh: install.refresh })
}

/** The installed Content live editing, or undefined when the host has no Realtime authority for it. */
export function contentLive(): ContentLiveInstall | undefined {
  return scope[liveKey]
}

/** The Realtime room of one document: the collection name, then the document id. */
export function contentLiveRoom(collection: string, id: string): string {
  return `${collection}/${id}`
}

/**
 * The `content.sessions` token that a live room holds the lease with. It depends only on the document, so a room that
 * restarts, such as a Durable Object that woke up, takes over its own lease.
 */
export async function contentLiveSession(collection: string, id: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${collection}\0${id}`)))
  return `live-${[...bytes.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`
}
