import { RealtimeDocumentConflict } from "@vite-hub/realtime"
import { isWorkspaceConflict } from "@vite-hub/workspace"

import { contentRealtimeEditor } from "./editor.ts"
import { contentLiveSession } from "./live.ts"

import type {
  RealtimeAuthorizeContext,
  RealtimeDefinition,
  RealtimeDocumentAdapter,
  RealtimeDocumentContext,
  RealtimeEditor,
  RealtimeFieldValue,
  RealtimeIssue,
  RealtimeRequestContext,
  RealtimeUser,
} from "@vite-hub/realtime"
import type { AnyContentCollection } from "./collections.ts"
import type { ContentFieldIssue } from "./documents.ts"
import type { ContentCanContext, ContentUser } from "./index.ts"
import type { ContentSessions } from "./sessions.ts"

export { contentEditorComponents, contentEditorKitOptions, contentMarkdownLoss, contentMarkdownLossOf, contentRealtimeEditor, describeContentMarkdownLoss } from "./editor.ts"
export type { ContentEditorCollection, ContentMarkdownLoss } from "./editor.ts"
export { contentLive, contentLiveRoom, contentLiveSession, installContentLive } from "./live.ts"
export type { ContentLiveInstall } from "./live.ts"

/** What `contentDocument()` needs from a Content runtime besides the collection: the sessions that hold leases. */
export interface ContentDocumentOptions {
  /** `content.sessions`. With it, the room holds the edit lease as `kind: 'live'` while people edit in it. */
  sessions?: ContentSessions
}

/** Plain JSON of document fields: dates become ISO strings, as in the Console. */
function jsonFields(data: Record<string, unknown>): Record<string, RealtimeFieldValue> {
  // SAFETY: A JSON round trip yields JSON values only.
  return JSON.parse(JSON.stringify(data ?? {})) as Record<string, RealtimeFieldValue>
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function realtimeIssues(issues: readonly ContentFieldIssue[] | undefined): RealtimeIssue[] | undefined {
  return issues?.map((issue) => {
    const result: RealtimeIssue = { message: issue.message, path: [...issue.path] }
    if (issue.field !== undefined) result.field = issue.field
    return result
  })
}

/** Who a revision names: the most recent editor as `author`, and everyone who edited since the last save. */
function liveMetadata(editors: readonly RealtimeUser[], user: RealtimeUser | undefined): Record<string, unknown> {
  const person = (entry: RealtimeUser) => Object.fromEntries(Object.entries({ id: entry.id, name: entry.name, email: entry.email }).filter(([, value]) => value))
  const metadata: Record<string, unknown> = { source: "live" }
  if (user) metadata.author = person(user)
  if (editors.length) metadata.editors = editors.map(person)
  return metadata
}

function errorCode(error: unknown): unknown {
  return error !== null && Object(error) === error ? Reflect.get(Object(error), "code") : undefined
}

/**
 * A Realtime document adapter over one Content collection or singleton. Rooms are the document ids of the collection.
 * `load()` reads the draft fields, the body without frontmatter, and the draft digest. `save()` saves into `draft` with
 * `ifDigest` and the room's lease session, so a save that crossed another writer throws `RealtimeDocumentConflict`
 * and the room re-seeds. Drafts accept fields in progress: their issues come back to the room status. Each revision
 * names the editors since the last save.
 */
export function contentDocument(collection: AnyContentCollection, options: ContentDocumentOptions = {}): RealtimeDocumentAdapter {
  const idOf = (context: RealtimeDocumentContext) => collection.kind === "singleton" ? collection.id : context.documentId
  return {
    kind: "content",
    async load(context) {
      const document = await collection.get(idOf(context), { ref: "draft" })
      if (!document) return { body: "", digest: null, fields: {} }
      return { body: document.body, digest: document.digest, fields: jsonFields(document.data) }
    },
    async save(context, snapshot, saveOptions) {
      const id = idOf(context)
      const fields = snapshot.fields ?? {}
      let saved
      try {
        saved = await collection.save(id, { data: fields, body: snapshot.body }, {
          ifDigest: saveOptions.ifDigest,
          metadata: liveMetadata(saveOptions.editors, saveOptions.user),
          session: await contentLiveSession(collection.name, id),
        })
      }
      catch (error) {
        if (isWorkspaceConflict(error)) throw new RealtimeDocumentConflict(`Content document ${JSON.stringify(`${collection.name}/${id}`)} changed outside the live room.`)
        throw error
      }
      const stored = jsonFields(saved.data)
      const result: Awaited<ReturnType<RealtimeDocumentAdapter["save"]>> = { digest: saved.digest }
      const issues = realtimeIssues(saved.issues)
      if (issues?.length) result.issues = issues
      // Content stores fields with their defaults and in its own form; the room merges them without a reset.
      if (saved.body !== snapshot.body || !jsonEqual(stored, fields)) result.stored = { body: saved.body, fields: stored }
      return result
    },
    async hold(context, { users }) {
      if (!options.sessions) return
      const id = idOf(context)
      const session = await contentLiveSession(collection.name, id)
      const names = users.map(user => user.name || user.email || user.id)
      const user = { id: `live:${session}`, name: names.join(", ") || "Live session", image: users[0]?.image ?? null }
      let result
      try {
        result = await options.sessions.acquire(collection.name, id, { kind: "live", session, user })
      }
      catch (error) {
        // Without the sessions table nobody holds leases, so live editing needs none.
        if (errorCode(error) === "CONTENT_R0012") return
        throw error
      }
      if (!result.editing && result.holder) {
        const holder = result.holder.user.name ?? result.holder.user.id
        throw new Error(`${holder} is editing this document alone. Live edits save once they stop or someone takes over.`)
      }
    },
    async release(context) {
      if (!options.sessions) return
      const id = idOf(context)
      try {
        await options.sessions.release(collection.name, id, { session: await contentLiveSession(collection.name, id) })
      }
      catch {
        // The lease expires on its own.
      }
    },
  }
}

/** The parts of a Content runtime that live editing uses. `defineContent()` returns one. */
export interface ContentLiveRuntime {
  collection(name: string): AnyContentCollection
  can(context: ContentCanContext): Promise<boolean>
  readonly live: "auto" | false
  readonly sessions: ContentSessions
}

export interface ContentRealtimeOptions {
  /** Resolve the person in the room, such as from the Console session. Defaults to the ViteHub Auth session. */
  identify?: RealtimeDefinition["identify"]
  /** A check before `content.can()`, such as Console section access. Return `false` to deny. */
  authorize?: (context: RealtimeAuthorizeContext) => boolean | void | Promise<boolean | void>
  /** The user that `content.can()` gets. Defaults to the identified Realtime user. */
  user?: (context: RealtimeRequestContext & { user: RealtimeUser | null }) => ContentUser | null | undefined | Promise<ContentUser | null | undefined>
}

/** The collection and id of a room `<collection>/<id>`, or undefined when it is not a Markdown document. */
export function contentLiveTarget(content: Pick<ContentLiveRuntime, "collection">, room: string): { collection: AnyContentCollection, id: string } | undefined {
  const slash = room.indexOf("/")
  const name = slash === -1 ? room : room.slice(0, slash)
  const rest = slash === -1 ? undefined : room.slice(slash + 1)
  let collection: AnyContentCollection
  try {
    collection = content.collection(name)
  }
  catch {
    return
  }
  if (collection.format !== "markdown") return
  if (collection.kind === "singleton") return rest === undefined || rest === collection.id ? { collection, id: collection.id } : undefined
  return rest ? { collection, id: rest } : undefined
}

/**
 * One Realtime Definition for every Markdown document of a Content runtime. Rooms are `<collection>/<id>`, or the
 * collection name of a singleton. Each collection gets its own codec from `contentRealtimeEditor()`, and the room holds
 * the edit lease as `kind: 'live'`. `authorize` maps to `content.can()`: reading a room needs `read`, editing needs
 * `write`. ViteHub contributes it as the `content` definition when Content and Realtime are enabled on a host with a
 * room authority.
 */
export function contentRealtime(content: ContentLiveRuntime, options: ContentRealtimeOptions = {}): RealtimeDefinition {
  const editors = new Map<string, RealtimeEditor>()
  const adapters = new Map<string, RealtimeDocumentAdapter>()
  function target(context: RealtimeDocumentContext) {
    const found = contentLiveTarget(content, context.documentId)
    if (!found) throw new Error(`No Content Markdown document matches the live room ${JSON.stringify(context.documentId)}.`)
    return found
  }
  function adapter(context: RealtimeDocumentContext): { adapter: RealtimeDocumentAdapter, context: RealtimeDocumentContext } {
    const { collection, id } = target(context)
    let found = adapters.get(collection.name)
    if (!found) {
      found = contentDocument(collection, { sessions: content.sessions })
      adapters.set(collection.name, found)
    }
    return { adapter: found, context: { ...context, documentId: id } }
  }
  const document: RealtimeDocumentAdapter = {
    kind: "content",
    load: async (context) => {
      const resolved = adapter(context)
      return await resolved.adapter.load(resolved.context)
    },
    save: async (context, snapshot, saveOptions) => {
      const resolved = adapter(context)
      return await resolved.adapter.save(resolved.context, snapshot, saveOptions)
    },
    hold: async (context, holdOptions) => {
      const resolved = adapter(context)
      await resolved.adapter.hold?.(resolved.context, holdOptions)
    },
    release: async (context) => {
      const resolved = adapter(context)
      await resolved.adapter.release?.(resolved.context)
    },
  }
  return {
    auth: true,
    identify: options.identify,
    document,
    editor: (context) => {
      const { collection } = target(context)
      let editor = editors.get(collection.name)
      if (!editor) {
        editor = contentRealtimeEditor(collection.kind === "documents" ? collection : {})
        editors.set(collection.name, editor)
      }
      return editor
    },
    async authorize(context) {
      if (content.live === false) return false
      if (options.authorize && (await options.authorize(context)) === false) return false
      // The Workspace event channel carries no document. Content rooms do not use it, so any identified person may listen.
      if (context.documentId === null) return context.mode === "read"
      const found = contentLiveTarget(content, context.documentId)
      if (!found) return false
      const user = options.user ? await options.user(context) : context.user && { ...context.user }
      return await content.can({ user: user ?? null, collection: found.collection.name, action: context.mode === "write" ? "write" : "read", id: found.id })
    },
  }
}
