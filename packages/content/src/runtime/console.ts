import { createViteHubConsoleActionError } from "@vite-hub/internal/console"

import type {
  ViteHubConsoleActionFailure,
  ViteHubConsoleDocument,
  ViteHubConsoleDocumentActionContext,
  ViteHubConsoleDocumentActions,
  ViteHubConsoleDocumentSetup,
  ViteHubConsoleDocumentActionsFactory,
  ViteHubConsoleDocumentActivity,
  ViteHubConsoleDocumentChange,
  ViteHubConsoleDocumentCollection,
  ViteHubConsoleDocumentComponent,
  ViteHubConsoleDocumentListInput,
  ViteHubConsoleDocumentOverviewCollection,
  ViteHubConsoleDocumentPage,
  ViteHubConsoleDocumentPendingChange,
  ViteHubConsoleDocumentPublishExpectation,
  ViteHubConsoleDocumentReference,
  ViteHubConsoleDocumentReferences,
  ViteHubConsoleDocumentRevision,
  ViteHubConsoleDocumentSearchResult,
  ViteHubConsoleDocumentSchedule,
  ViteHubConsoleDocumentScheduled,
  ViteHubConsoleDocumentScheduledChange,
  ViteHubConsoleDocumentPresence,
  ViteHubConsoleDocumentSession,
  ViteHubConsoleDocumentSessionAction,
  ViteHubConsoleDocumentSessions,
  ViteHubConsoleDocumentSessionUser,
  ViteHubConsoleDocumentState,
  ViteHubConsoleDocumentSummary,
  ViteHubConsoleMediaAccess,
} from "@vite-hub/internal/console"
import type { ContentAction, ContentDocumentsRuntime } from "../index.ts"
import type { AnyContentCollection, ContentDocument, ContentDocumentStatus, ContentDocumentSummary, ContentListOptions } from "../collections.ts"
import type { ContentDocumentSchedule, ContentSchedule } from "../schedules.ts"
import type { ContentDocumentSessions, ContentSession } from "../sessions.ts"
import { contentLive } from "../live.ts"

type ContentRuntime = Pick<ContentDocumentsRuntime, "can" | "collection" | "collections" | "publish" | "revisions" | "schedule" | "schedules" | "unschedule">
  & Partial<Pick<ContentDocumentsRuntime, "hasPolicy" | "live" | "sessions">>

const sessionActions: readonly ViteHubConsoleDocumentSessionAction[] = ["report", "acquire", "takeover", "release"]

const documentStates: readonly ViteHubConsoleDocumentState[] = ["draft", "published", "changed", "deleted"]
const maximumListLimit = 200
const maximumActivity = 50
const maximumSearchLimit = 50
const maximumReferencePathnames = 100
const referencePageSize = 1_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function isContentRuntime(value: unknown): value is ContentRuntime {
  return isRecord(value)
    && value.collection instanceof Function
    && value.collections instanceof Function
    && value.can instanceof Function
    && value.publish instanceof Function
    && value.revisions instanceof Function
    && value.schedule instanceof Function
    && value.schedules instanceof Function
    && value.unschedule instanceof Function
}

function contentRuntime(value: unknown): ContentRuntime {
  if (!isContentRuntime(value)) throw new TypeError("[vitehub] server/content.ts must export the defineContent() runtime as `content`.")
  return value
}

function failure(status: ViteHubConsoleActionFailure["status"], code: string, message: string, details?: Record<string, unknown>): Error {
  return createViteHubConsoleActionError(details ? { status, code, message, details } : { status, code, message })
}

function invalidInput(message: string): Error {
  return failure(400, "CONTENT_CONSOLE_INPUT", message)
}

function text(value: unknown, name: string): string {
  if (String(value) !== value || !value) throw invalidInput(`${name} must be a non-empty string.`)
  return value
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name)
}

function digest(value: unknown, name = "ifDigest"): string | null {
  if (value === null) return null
  return text(value, name)
}

/** JSON-safe copy, so `Date` values reach the editor as ISO strings. */
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** Plain JSON values only: the editor sends field values as JSON. */
function fieldValues(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidInput("data must be an object of field values.")
  return value
}

/** The documents whose draft moved after review, from a `publish({ expect })` conflict. */
function publishMismatches(details: Record<string, unknown>): Array<{ id: string, expected: string | null, actual: string | null }> | undefined {
  if (!Array.isArray(details.documents)) return
  return details.documents.flatMap((entry: unknown) => {
    if (!isRecord(entry) || String(entry.id) !== entry.id) return []
    const digestOrNull = (value: unknown) => String(value) === value ? value : null
    return [{ id: entry.id, expected: digestOrNull(entry.expected), actual: digestOrNull(entry.actual) }]
  })
}

/** Translate the errors that a Content runtime method throws into failures the editor shows. */
function translate(error: unknown): never {
  const code: unknown = Reflect.get(Object(error), "code")
  const details: unknown = Reflect.get(Object(error), "details")
  const message = error instanceof Error ? error.message : String(error)
  if (code === "CONTENT_INVALID" && isRecord(details)) {
    // `publish()` names the draft that no longer validates, so the editor can point at that document.
    const id = String(details.id) === details.id ? details.id : undefined
    const documents = Array.isArray(details.documents)
      ? details.documents.flatMap((entry: unknown) => isRecord(entry) && String(entry.id) === entry.id ? [{ id: entry.id, issues: json(entry.issues ?? []) }] : [])
      : undefined
    const message = documents && documents.length > 1 ? `${documents.length} documents have invalid fields.` : id ? `${id} has invalid fields.` : "Some fields are invalid."
    const result: Record<string, unknown> = id ? { id, issues: json(details.issues ?? []) } : { issues: json(details.issues ?? []) }
    if (documents) result.documents = documents
    throw failure(422, "CONTENT_INVALID", message, result)
  }
  if (code === "WORKSPACE_CONFLICT") {
    const conflict = isRecord(details) ? details : {}
    const documents = publishMismatches(conflict)
    if (documents) {
      throw failure(409, "WORKSPACE_CONFLICT", `${documents.length === 1 ? "1 document" : `${documents.length} documents`} changed since you reviewed them. Nothing was published.`, { documents, ref: "draft" })
    }
    throw failure(409, "WORKSPACE_CONFLICT", "This document changed since you opened it.", {
      actual: conflict.actual ?? null,
      expected: conflict.expected ?? null,
      ref: conflict.ref ?? null,
    })
  }
  if (code === "CONTENT_NOT_FOUND") throw failure(404, "CONTENT_NOT_FOUND", "This document does not exist.")
  if (code === "CONTENT_LEASE_HELD" && isRecord(details) && isRecord(details.holder)) {
    // Another tab holds the edit lease. The editor names the holder and offers to take over.
    const holder = details.holder
    const user = isRecord(holder.user) ? holder.user : {}
    const name = String(user.name) === user.name && user.name ? user.name : String(user.id ?? "Someone")
    const view: Record<string, unknown> = { user: { id: String(user.id ?? ""), name, ...(String(user.image) === user.image && user.image ? { image: user.image } : {}) }, since: holder.since ?? null }
    throw failure(409, "CONTENT_LEASE_HELD", `${name} is editing this document.`, { holder: view })
  }
  // Input diagnostics, such as a bad id or a stale cursor, describe the request rather than the server.
  if (String(code) === code && /^(?:CONTENT|SOURCE)_R\d+$/.test(code)) throw failure(400, code, message)
  throw error
}

async function attempt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  }
  catch (error) {
    translate(error)
  }
}

function label(name: string): string {
  return name.split(/[-_/\s]+/).filter(Boolean).map(part => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ")
}

/**
 * The name of a document: a singleton's label, else its title field, else its id. A singleton is named by its label,
 * as the editor and the Settings page name it, so the dashboard never shows a file name such as `settings`.
 */
function titleOf(collection: AnyContentCollection, data: Record<string, unknown> | undefined, id: string): string {
  if (collection.kind === "singleton") return collection.label
  const title = collection.titleField && data ? data[collection.titleField] : undefined
  return String(title) === title && title.trim() ? title : id
}

/** The `{ id, digest }` entries of a publish or schedule request. */
function expectations(value: readonly unknown[]): ViteHubConsoleDocumentPublishExpectation[] {
  return value.map((entry: unknown) => {
    if (!isRecord(entry)) throw invalidInput("Each expect entry must be { id, digest }.")
    return { id: text(entry.id, "expect.id"), digest: digest(entry.digest, "expect.digest") }
  })
}

/** The tab token that a write carries, so the tab's own lease does not block it. */
function writeSession(input: Record<string, unknown>): { session?: string } {
  const session = optionalText(input.session, "session")
  return session ? { session } : {}
}

/** Signed-in user fields worth recording as the author of a revision. */
function author(context: ViteHubConsoleDocumentActionContext): Record<string, string> | undefined {
  const user = context.user
  if (!user) return
  const fields = Object.fromEntries(["id", "name", "email"].flatMap((key) => {
    const value = user[key]
    return String(value) === value && value ? [[key, value]] : []
  }))
  return Object.keys(fields).length ? fields : undefined
}

function writeMetadata(context: ViteHubConsoleDocumentActionContext): Record<string, unknown> {
  const by = author(context)
  return by ? { author: by, source: "console" } : { source: "console" }
}

/**
 * Why a schedule run published nothing. The runtime message names every document of the schedule that failed, and
 * the user may not read all of them, so the Console says it without document ids.
 */
function scheduleFailure(code: string): string {
  if (code === "WORKSPACE_CONFLICT") return "A document changed after it was scheduled, so nothing was published."
  if (code === "CONTENT_INVALID") return "A document has invalid fields, so nothing was published."
  return "Nothing was published."
}

function scheduleView(schedule: ContentDocumentSchedule | ContentSchedule): ViteHubConsoleDocumentSchedule {
  const result: ViteHubConsoleDocumentSchedule = { id: schedule.id, at: schedule.at, status: schedule.status }
  if (schedule.failure) result.failure = scheduleFailure(schedule.failure.code)
  return result
}

function personName(by: unknown): string | undefined {
  if (!isRecord(by)) return
  for (const key of ["name", "email", "id"]) {
    const value = by[key]
    if (String(value) === value && value) return value
  }
}

/** Who saved a revision: its author, or every editor of a live save, such as `Ana and Ben`. */
function revisionAuthor(metadata: Record<string, unknown> | undefined): string | undefined {
  const editors = Array.isArray(metadata?.editors) ? metadata.editors.map(personName).filter(name => name !== undefined) : []
  if (editors.length > 1) return `${editors.slice(0, -1).join(", ")} and ${editors.at(-1)}`
  return personName(metadata?.author)
}

function revisionAction(metadata: Record<string, unknown> | undefined): string {
  const content = metadata?.content
  const action = isRecord(content) ? content.action : undefined
  return String(action) === action ? action : "change"
}

/** True when a field value is the pathname, as a string or as a Blob reference `{ pathname }`, at any depth. */
function usesPathname(value: unknown, pathnames: ReadonlySet<string>, found: Set<string>): void {
  if (String(value) === value) {
    if (pathnames.has(value)) found.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) usesPathname(entry, pathnames, found)
    return
  }
  if (!isRecord(value)) return
  for (const entry of Object.values(value)) usesPathname(entry, pathnames, found)
}

/** The Console user as sessions show them: a display name, and an image when the user has one. */
function sessionUser(context: ViteHubConsoleDocumentActionContext): ViteHubConsoleDocumentSessionUser | null {
  const user = context.user
  if (!user) return null
  const read = (key: string) => String(user[key]) === user[key] && user[key] ? user[key] as string : undefined
  const id = read("id") ?? read("email")
  if (!id) return null
  const result: ViteHubConsoleDocumentSessionUser = { id, name: read("name") ?? read("email") ?? id }
  const image = read("image")
  if (image) result.image = image
  return result
}

function sessionView(entry: ContentSession, session: string | undefined): ViteHubConsoleDocumentSession {
  const user: ViteHubConsoleDocumentSessionUser = { id: entry.user.id, name: entry.user.name ?? entry.user.id }
  if (entry.user.image) user.image = entry.user.image
  return { collection: entry.collection, id: entry.id, user, kind: entry.kind, since: entry.since, self: entry.session === session }
}

/** Sessions that the owner cannot track, such as without the sessions table, leave the editor editable. */
function sessionsUnavailable(error: unknown): string | undefined {
  if (Reflect.get(Object(error), "code") !== "CONTENT_R0012") return
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^\[vitehub\]\s*/, "")
}

/**
 * Create the Console document actions for the `content` export of `server/content.ts`. Every action checks
 * `content.can()` with the signed-in Console user before it calls the trusted runtime method.
 */
export const createContentConsoleActions: ViteHubConsoleDocumentActionsFactory = (module) => {
  const content = contentRuntime(module.content)

  function open(name: unknown): AnyContentCollection {
    const collectionName = text(name, "collection")
    if (!content.collections().some(collection => collection.name === collectionName)) {
      throw failure(404, "CONTENT_COLLECTION_NOT_FOUND", `Content has no collection named ${JSON.stringify(collectionName)}.`)
    }
    return content.collection(collectionName)
  }

  async function allow(context: ViteHubConsoleDocumentActionContext, collection: AnyContentCollection, action: ContentAction, id?: string): Promise<void> {
    const allowed = await content.can(id === undefined
      ? { user: context.user, collection: collection.name, action }
      : { user: context.user, collection: collection.name, action, id })
    if (!allowed) {
      throw failure(403, "CONTENT_FORBIDDEN", `You cannot ${action === "read" ? "read drafts of" : action === "write" ? "edit" : "publish"} this ${id === undefined ? "collection" : "document"}.`)
    }
  }

  /** Every document status of a collection, or the one status of a singleton. */
  async function statusesOf(collection: AnyContentCollection): Promise<ContentDocumentStatus[]> {
    if (collection.kind === "documents") return await collection.status()
    const status = await collection.status()
    return status ? [status] : []
  }

  /** The ids the user may read. The Console checks each document so a list, count, or title never shows one it hides. */
  async function readableIds(context: ViteHubConsoleDocumentActionContext, collection: AnyContentCollection, ids: Iterable<string>): Promise<Set<string>> {
    const list = [...new Set(ids)]
    const allowed = await Promise.all(list.map(id => content.can({ user: context.user, collection: collection.name, action: "read", id })))
    return new Set(list.filter((_id, index) => allowed[index]))
  }

  /** {@link statusesOf}, without the documents the user may not read. */
  async function readableStatusesOf(context: ViteHubConsoleDocumentActionContext, collection: AnyContentCollection): Promise<ContentDocumentStatus[]> {
    const statuses = await statusesOf(collection)
    const ids = await readableIds(context, collection, statuses.map(status => status.id))
    return statuses.filter(status => ids.has(status.id))
  }

  async function view(collection: AnyContentCollection, document: ContentDocument): Promise<ViteHubConsoleDocument> {
    const result: ViteHubConsoleDocument = {
      collection: document.collection,
      id: document.id,
      path: document.path,
      data: json(document.data),
      body: document.body,
      digest: document.digest,
      revision: document.revision,
      updatedAt: document.updatedAt,
    }
    if (document.url !== undefined) result.url = document.url
    if (document.issues?.length) result.issues = json(document.issues)
    const status = await collection.status(document.id)
    if (status) result.state = status.state
    if (status?.schedule) result.schedule = scheduleView(status.schedule)
    return result
  }

  async function readable(context: ViteHubConsoleDocumentActionContext): Promise<AnyContentCollection[]> {
    const collections = content.collections()
    const allowed = await Promise.all(collections.map(collection => content.can({ user: context.user, collection: collection.name, action: "read" })))
    return collections.filter((_collection, index) => allowed[index])
  }

  /** Summaries of some documents in one read per ref: drafts from `draft`, documents deleted on the draft from `published`. */
  async function summaries(collection: AnyContentCollection, ids: ReadonlySet<string>, statuses: ReadonlyMap<string, ContentDocumentStatus>): Promise<Map<string, ContentDocumentSummary>> {
    const onDraft = [...ids].filter(id => statuses.get(id)?.draft != null)
    const onPublished = [...ids].filter(id => statuses.get(id)?.draft == null && statuses.get(id)?.published != null)
    const read = async (ref: "draft" | "published", list: string[]): Promise<ContentDocumentSummary[]> => list.length
      ? (await collection.list({ ref, filter: { id: list }, limit: Math.min(list.length, 1_000) })).items
      : []
    const pages = await Promise.all([read("draft", onDraft), read("published", onPublished)])
    return new Map(pages.flat().map(item => [item.id, item]))
  }

  const actions: ViteHubConsoleDocumentActions = {
    async collections(context) {
      const collections: ViteHubConsoleDocumentCollection[] = []
      for (const collection of content.collections()) {
        const [read, write, publish] = await Promise.all((["read", "write", "publish"] as const).map(action =>
          content.can({ user: context.user, collection: collection.name, action })))
        if (!read) continue
        const schema = json(collection.schema)
        const entry: ViteHubConsoleDocumentCollection = {
          name: collection.name,
          label: collection.label,
          path: collection.path,
          kind: collection.kind,
          format: collection.format,
          schema,
          access: { read: Boolean(read), write: Boolean(write), publish: Boolean(publish) },
        }
        if (collection.kind === "singleton") entry.document = collection.id
        if (collection.kind === "documents" && collection.singularLabel) entry.singularLabel = collection.singularLabel
        if (collection.titleField) entry.titleField = collection.titleField
        const components = Object.entries(collection.kind === "documents" ? collection.components : {}).map(([name, component]) => {
          const described: ViteHubConsoleDocumentComponent = { name, kind: component.kind ?? "block", label: component.label ?? label(name), props: json(component.props ?? {}) }
          if (component.description) described.description = component.description
          return described
        })
        if (components.length) entry.components = components
        collections.push(entry)
      }
      return collections
    },

    setup() {
      const setup: ViteHubConsoleDocumentSetup = {}
      // Without a policy `content.can()` denies everything, so the editor names the fix instead of an empty section.
      if (content.hasPolicy === false) {
        setup.access = { message: "Add `authorize` to `defineContent()` to decide who may read, edit, and publish documents.", docs: "https://vitehub.dev/docs/content/configure#access" }
      }
      // Live editing covers Markdown documents. Where the host has no Realtime authority, the editor keeps one editor at a time.
      if (content.live !== false && content.collections().some(collection => collection.format === "markdown")) {
        const live = contentLive()
        setup.live = live
          ? { definition: live.definition }
          : { unavailable: "Live editing needs Realtime on a host with a room authority, such as a Node server or Cloudflare Durable Objects." }
      }
      return setup
    },

    async list(input: ViteHubConsoleDocumentListInput, context): Promise<ViteHubConsoleDocumentPage> {
      if (!isRecord(input)) throw invalidInput("list() requires { collection }.")
      const collection = open(input.collection)
      await allow(context, collection, "read")
      if (input.state !== undefined && !documentStates.includes(input.state)) throw invalidInput("state must be draft, published, changed, or deleted.")
      const limit = input.limit ?? 50
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumListLimit) throw invalidInput(`limit must be an integer from 1 to ${maximumListLimit}.`)
      return await attempt(async () => {
        const authorizedStatuses = await readableStatusesOf(context, collection)
        const states: Record<ViteHubConsoleDocumentState, number> = { draft: 0, published: 0, changed: 0, deleted: 0 }
        const statusById = new Map(authorizedStatuses.map(status => [status.id, status]))
        const changes: ViteHubConsoleDocumentChange[] = []
        let scheduled = 0
        for (const status of authorizedStatuses) {
          states[status.state]++
          if (status.schedule) scheduled++
          if (status.state !== "published") changes.push({ id: status.id, state: status.state, digest: status.draft, ...(status.issues ? { issues: status.issues } : {}) })
        }
        const filter: NonNullable<ContentListOptions["filter"]> = {}
        for (const [field, value] of Object.entries(isRecord(input.filter) ? input.filter : {})) {
          const values = Array.isArray(value) ? value : [value]
          if (!values.every(entry => String(entry) === entry)) throw invalidInput("filter values must be strings.")
          if (values.length) Object.assign(filter, { [field]: values })
        }
        // Deleted documents exist only on `published`, so that state lists them from there.
        let ref: "draft" | "published" = "draft"
        const ids = authorizedStatuses
          .filter(status => (!input.state || status.state === input.state) && (!input.scheduled || status.schedule))
          .map(status => status.id)
        if (!ids.length) return { items: [], nextCursor: null, total: 0, states, changes, scheduled }
        Object.assign(filter, { id: ids })
        if (input.state === "deleted") ref = "published"
        const options: ContentListOptions = { ref, filter, limit }
        const search = optionalText(input.search?.trim() || undefined, "search")
        if (search) options.search = search
        if (input.cursor !== undefined) options.cursor = text(input.cursor, "cursor")
        if (input.sort) options.sort = { field: text(input.sort.field, "sort.field"), direction: input.sort.direction === "desc" ? "desc" : "asc" }
        if (input.facets?.length) options.facets = input.facets.map(field => text(field, "facets"))
        const page = await collection.list(options)
        const result: ViteHubConsoleDocumentPage = {
          items: page.items.map((item) => {
            const status = statusById.get(item.id)
            const summary: ViteHubConsoleDocumentSummary = {
              id: item.id,
              path: item.path,
              title: titleOf(collection, item.data, item.id),
              state: status?.state ?? (ref === "published" ? "deleted" : "draft"),
              data: json(item.data),
              // A deleted document is listed from `published`, but publishing it expects no draft.
              digest: status ? status.draft : ref === "draft" ? item.digest : null,
              updatedAt: item.updatedAt,
            }
            if (status?.schedule) summary.schedule = scheduleView(status.schedule)
            if (status?.issues) summary.issues = status.issues
            return summary
          }),
          nextCursor: page.nextCursor,
          total: page.total,
          states,
          changes,
          scheduled,
        }
        if (page.facets) result.facets = json(page.facets)
        return result
      })
    },

    async get(input, context) {
      if (!isRecord(input)) throw invalidInput("get() requires { collection, id }.")
      const collection = open(input.collection)
      const id = text(input.id, "id")
      await allow(context, collection, "read", id)
      return await attempt(async () => {
        const document = await collection.get(id, { ref: "draft" })
        return document ? await view(collection, document) : null
      })
    },

    async raw(input, context) {
      if (!isRecord(input)) throw invalidInput("raw() requires { collection, id }.")
      const collection = open(input.collection)
      const id = text(input.id, "id")
      await allow(context, collection, "read", id)
      const revision = optionalText(input.revision, "revision")
      return await attempt(async () => {
        const file = await collection.raw(id, revision ? { revision } : { ref: "draft" })
        return file ? { ...file } : null
      })
    },

    async save(input, context) {
      if (!isRecord(input)) throw invalidInput("save() requires { collection, id, data, body, ifDigest }.")
      const collection = open(input.collection)
      const id = text(input.id, "id")
      await allow(context, collection, "write", id)
      if (String(input.body) !== input.body) throw invalidInput("body must be a Markdown string.")
      const data = fieldValues(input.data)
      const ifDigest = digest(input.ifDigest)
      return await attempt(async () => await view(collection, await collection.save(id, { data, body: input.body }, { ifDigest, metadata: writeMetadata(context), ...writeSession(input) })))
    },

    async remove(input, context) {
      if (!isRecord(input)) throw invalidInput("remove() requires { collection, id, ifDigest }.")
      const collection = open(input.collection)
      const id = text(input.id, "id")
      await allow(context, collection, "write", id)
      const ifDigest = text(input.ifDigest, "ifDigest")
      await attempt(async () => await collection.remove(id, { ifDigest, metadata: writeMetadata(context), ...writeSession(input) }))
    },

    async publish(input, context) {
      if (!isRecord(input) || !Array.isArray(input.expect) || !input.expect.length) {
        throw invalidInput("publish() requires { collection, expect: [{ id, digest }] } with the draft digests that were reviewed.")
      }
      const collection = open(input.collection)
      const expected = expectations(input.expect)
      for (const { id } of expected) await allow(context, collection, "publish", id)
      return await attempt(async () => {
        // Publish exactly the reviewed drafts: a draft saved after review fails instead of being published.
        const result = await content.publish({
          expect: expected.map(({ id, digest }) => ({ collection: collection.name, id, digest })),
          metadata: writeMetadata(context),
        })
        return { revision: result.revision?.id ?? null, documents: result.documents.map(document => ({ ...document })) }
      })
    },

    async schedule(input, context): Promise<ViteHubConsoleDocumentScheduled> {
      if (!isRecord(input) || !Array.isArray(input.expect) || !input.expect.length) {
        throw invalidInput("schedule() requires { collection, at, expect: [{ id, digest }] } with the draft digests that were reviewed.")
      }
      const collection = open(input.collection)
      const at = text(input.at, "at")
      const expected = expectations(input.expect)
      for (const { id } of expected) await allow(context, collection, "publish", id)
      return await attempt(async () => {
        const schedule = await content.schedule({
          at,
          expect: expected.map(({ id, digest }) => ({ collection: collection.name, id, digest })),
          metadata: writeMetadata(context),
        })
        return { ...scheduleView(schedule), documents: schedule.expect.map(({ id, digest }) => ({ id, digest })) }
      })
    },

    async unschedule(input, context) {
      if (!isRecord(input)) throw invalidInput("unschedule() requires { collection, schedule }.")
      const collection = open(input.collection)
      const id = text(input.schedule, "schedule")
      await allow(context, collection, "read")
      const schedule = (await attempt(() => content.schedules({ collection: collection.name }))).find(entry => entry.id === id)
      if (!schedule) throw failure(404, "CONTENT_SCHEDULE_NOT_FOUND", "This schedule already ran or was cancelled.")
      // Cancelling decides what gets published, so it needs publish access to every document of the schedule.
      for (const document of schedule.expect) await allow(context, open(document.collection), "publish", document.id)
      await attempt(async () => {
        try {
          await content.unschedule(id, { metadata: writeMetadata(context) })
        }
        catch (error) {
          if (Reflect.get(Object(error), "code") === "CONTENT_NOT_FOUND") throw failure(404, "CONTENT_SCHEDULE_NOT_FOUND", "This schedule already ran or was cancelled.")
          throw error
        }
      })
    },

    async revisions(input, context) {
      if (!isRecord(input)) throw invalidInput("revisions() requires { collection, id }.")
      const collection = open(input.collection)
      const id = text(input.id, "id")
      await allow(context, collection, "read", id)
      const cursor = optionalText(input.cursor, "cursor")
      return await attempt(async () => {
        // Saves live on `draft` and publishes on `published`. Later pages continue the draft history only.
        const [draft, published] = await Promise.all([
          content.revisions(collection.name, id, cursor ? { ref: "draft", cursor } : { ref: "draft" }),
          cursor ? undefined : content.revisions(collection.name, id, { ref: "published" }),
        ])
        const revisions: ViteHubConsoleDocumentRevision[] = [...draft.revisions, ...published?.revisions ?? []]
          .map((revision) => {
            const entry: ViteHubConsoleDocumentRevision = { id: revision.id, ref: revision.ref, createdAt: revision.createdAt, action: revisionAction(revision.metadata) }
            if (revision.message) entry.message = revision.message
            const by = revisionAuthor(revision.metadata)
            if (by) entry.author = by
            return entry
          })
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        return draft.cursor ? { revisions, cursor: draft.cursor } : { revisions }
      })
    },

    async restore(input, context) {
      if (!isRecord(input)) throw invalidInput("restore() requires { collection, id, revision, ifDigest }.")
      const collection = open(input.collection)
      const id = text(input.id, "id")
      await allow(context, collection, "write", id)
      const revision = text(input.revision, "revision")
      const ifDigest = digest(input.ifDigest)
      return await attempt(async () => await view(collection, await collection.restore(id, revision, { ifDigest, metadata: writeMetadata(context), ...writeSession(input) })))
    },

    async session(input, context): Promise<ViteHubConsoleDocumentPresence> {
      if (!isRecord(input)) throw invalidInput("session() requires { collection, id, session, action }.")
      const collection = open(input.collection)
      const id = text(input.id, "id")
      const session = text(input.session, "session")
      const action = input.action
      if (!sessionActions.includes(action)) throw invalidInput("action must be report, acquire, takeover, or release.")
      // Viewing needs read access. Taking the lease, free or held, needs write access: readers never see Take over.
      await allow(context, collection, action === "acquire" || action === "takeover" ? "write" : "read", id)
      if (input.kind !== undefined && input.kind !== "view" && input.kind !== "edit") throw invalidInput("kind must be view or edit.")
      const user = sessionUser(context)
      const sessionsUser = user ? { id: user.id, name: user.name, image: user.image ?? null } : { id: "anonymous", name: "Someone" }
      const presence = (result: Omit<ViteHubConsoleDocumentPresence, "user" | "lease">): ViteHubConsoleDocumentPresence =>
        ({ user, lease: collection.editing.lease, ...result })
      const sessions = content.sessions
      if (!sessions) return presence({ available: false, reason: "This Content runtime does not track sessions.", editing: true, holder: null, sessions: [], now: new Date().toISOString() })
      try {
        if (action === "release") {
          await sessions.release(collection.name, id, { session })
          return presence({ available: true, editing: false, holder: null, sessions: [], now: new Date().toISOString() })
        }
        const [result, status] = await Promise.all([
          action === "report"
            ? sessions.report(collection.name, id, { session, user: sessionsUser, kind: input.kind ?? "view", input: input.input === true })
            : sessions.acquire(collection.name, id, { session, user: sessionsUser, takeover: action === "takeover" }),
          // The draft digest lets an open editor notice a save from another tab without reading the document.
          collection.status(id),
        ]) as [ContentDocumentSessions, ContentDocumentStatus | null]
        return presence({
          digest: status?.draft ?? null,
          available: true,
          editing: result.editing,
          holder: result.holder ? sessionView(result.holder, session) : null,
          sessions: result.sessions.map(entry => sessionView(entry, session)),
          now: result.now,
        })
      }
      catch (error) {
        const reason = sessionsUnavailable(error)
        if (reason) return presence({ available: false, reason, editing: true, holder: null, sessions: [], now: new Date().toISOString() })
        translate(error)
      }
    },

    async sessions(input, context): Promise<ViteHubConsoleDocumentSessions> {
      const options = isRecord(input) ? input : {}
      const session = optionalText(options.session, "session")
      const collections = options.collection === undefined ? await readable(context) : [open(options.collection)]
      if (options.collection !== undefined) await allow(context, collections[0]!, "read")
      const user = sessionUser(context)
      if (!content.sessions) return { user, available: false, reason: "This Content runtime does not track sessions.", sessions: [] }
      const names = new Set(collections.map(collection => collection.name))
      try {
        const listed = (await content.sessions.list(collections.length === 1 ? collections[0]!.name : undefined)).filter(entry => names.has(entry.collection))
        // A session names its document, so each document needs read access, as in the list.
        const readableByCollection = new Map(await Promise.all(collections.map(async collection => [
          collection.name,
          await readableIds(context, collection, listed.filter(entry => entry.collection === collection.name).map(entry => entry.id)),
        ] as const)))
        const visible = listed.filter(entry => readableByCollection.get(entry.collection)?.has(entry.id))
        return { user, available: true, sessions: visible.map(entry => sessionView(entry, session)) }
      }
      catch (error) {
        const reason = sessionsUnavailable(error)
        if (reason) return { user, available: false, reason, sessions: [] }
        translate(error)
      }
    },

    async overview(input, context) {
      const limit = isRecord(input) && input.activity !== undefined ? input.activity : 20
      if (!Number.isSafeInteger(limit) || limit < 0 || limit > maximumActivity) throw invalidInput(`activity must be an integer from 0 to ${maximumActivity}.`)
      const collections = await readable(context)
      const names = new Set(collections.map(collection => collection.name))
      return await attempt(async () => {
        // Saves, removes, and restores live on `draft`; publishes on `published`. Each ref is read once.
        const [draft, published] = limit
          ? await Promise.all((["draft", "published"] as const).map(ref => content.revisions({ ref, limit })))
          : [{ revisions: [] }, { revisions: [] }]
        const revisions = [...draft!.revisions, ...published!.revisions]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(0, limit)
        const mentioned = new Map<string, Set<string>>()
        const activity: ViteHubConsoleDocumentActivity[] = revisions.flatMap((revision) => {
          const content = revision.metadata?.content
          const listed: unknown = isRecord(content) ? content.documents : undefined
          const documents = (Array.isArray(listed) ? listed : []).flatMap((document: unknown) => {
            if (!isRecord(document) || String(document.collection) !== document.collection || String(document.id) !== document.id || !names.has(document.collection)) return []
            ;(mentioned.get(document.collection) ?? mentioned.set(document.collection, new Set()).get(document.collection)!).add(document.id)
            return [{ collection: document.collection, id: document.id, title: document.id }]
          })
          if (!documents.length) return []
          const entry: ViteHubConsoleDocumentActivity = { id: revision.id, ref: revision.ref, createdAt: revision.createdAt, action: revisionAction(revision.metadata), documents }
          const by = revisionAuthor(revision.metadata)
          if (by) entry.author = by
          return [entry]
        })
        const titles = new Map<string, string>()
        const readableMentions = new Map<string, ReadonlySet<string>>()
        const overviews = await Promise.all(collections.map(async (collection): Promise<ViteHubConsoleDocumentOverviewCollection> => {
          const statuses = await readableStatusesOf(context, collection)
          const states: Record<ViteHubConsoleDocumentState, number> = { draft: 0, published: 0, changed: 0, deleted: 0 }
          for (const status of statuses) states[status.state]++
          const pending = statuses.filter(status => status.state !== "published")
          const byId = new Map(statuses.map(status => [status.id, status]))
          // Activity can name documents that have no status now, so those ids get their own check.
          const mentions = [...mentioned.get(collection.name) ?? []]
          const others = await readableIds(context, collection, mentions.filter(id => !byId.has(id)))
          const visible = mentions.filter(id => byId.has(id) || others.has(id))
          readableMentions.set(collection.name, new Set(visible))
          const withSchedule = statuses.filter(status => status.schedule)
          const found = await summaries(collection, new Set([...pending.map(status => status.id), ...withSchedule.map(status => status.id), ...visible]), byId)
          for (const [id, summary] of found) titles.set(`${collection.name}\u0000${id}`, titleOf(collection, summary.data, id))
          const changes: ViteHubConsoleDocumentPendingChange[] = pending.map((status) => {
            const summary = found.get(status.id)
            const change: ViteHubConsoleDocumentPendingChange = {
              id: status.id,
              // SAFETY: `pending` leaves out published documents.
              state: status.state as ViteHubConsoleDocumentPendingChange["state"],
              digest: status.draft,
              title: titleOf(collection, summary?.data, status.id),
              updatedAt: status.state === "deleted" ? null : summary?.updatedAt ?? null,
            }
            if (status.issues) change.issues = status.issues
            return change
          })
          changes.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.id.localeCompare(right.id))
          const scheduled: ViteHubConsoleDocumentScheduledChange[] = withSchedule
            .flatMap(status => status.schedule ? [{ id: status.id, title: titleOf(collection, found.get(status.id)?.data, status.id), schedule: scheduleView(status.schedule) }] : [])
            .sort((left, right) => left.schedule.at.localeCompare(right.schedule.at) || left.id.localeCompare(right.id))
          return { name: collection.name, states, changes, scheduled }
        }))
        const visibleActivity = activity.flatMap((entry) => {
          const documents = entry.documents.filter(document => readableMentions.get(document.collection)?.has(document.id))
          for (const document of documents) document.title = titles.get(`${document.collection}\u0000${document.id}`) ?? document.id
          return documents.length ? [{ ...entry, documents }] : []
        })
        return { collections: overviews, activity: visibleActivity }
      })
    },

    async references(input, context): Promise<ViteHubConsoleDocumentReferences> {
      if (!isRecord(input) || !Array.isArray(input.pathnames)) throw invalidInput("references() requires { pathnames }.")
      const pathnames = [...new Set(input.pathnames.map(pathname => text(pathname, "pathnames")))]
      if (pathnames.length > maximumReferencePathnames) throw invalidInput(`pathnames must list at most ${maximumReferencePathnames} pathnames.`)
      const wanted = new Set(pathnames)
      const collections = await readable(context)
      return await attempt(async () => {
        const found = new Map<string, Map<string, ViteHubConsoleDocumentReference>>(pathnames.map(pathname => [pathname, new Map()]))
        await Promise.all(collections.map(async (collection) => {
          // The references of this collection by pathname and id. Only the documents the user may read reach `found`.
          const local = new Map<string, Map<string, ViteHubConsoleDocumentReference>>(pathnames.map(pathname => [pathname, new Map()]))
          for (const ref of ["draft", "published"] as const) {
            const add = (pathname: string, item: Pick<ContentDocumentSummary, "data" | "id">) => {
              const documents = local.get(pathname)!
              const reference = documents.get(item.id)
              if (reference) {
                if (!reference.refs.includes(ref)) reference.refs.push(ref)
                return
              }
              documents.set(item.id, { collection: collection.name, id: item.id, title: titleOf(collection, item.data, item.id), refs: [ref] })
            }
            // Field values: walk every document once for all pathnames. The collection index is cached per revision.
            let cursor: string | undefined
            do {
              const page = await collection.list(cursor ? { ref, limit: referencePageSize, cursor } : { ref, limit: referencePageSize })
              for (const item of page.items) {
                const used = new Set<string>()
                usesPathname(item.data, wanted, used)
                for (const pathname of used) add(pathname, item)
              }
              cursor = page.nextCursor ?? undefined
            } while (cursor)
            // Bodies: the collection search covers the body of Markdown documents, so a link or an image finds it.
            if (collection.format !== "markdown") continue
            for (const pathname of pathnames) {
              const page = await collection.list({ ref, search: pathname, limit: referencePageSize })
              for (const item of page.items) add(pathname, item)
            }
          }
          const ids = await readableIds(context, collection, [...local.values()].flatMap(documents => [...documents.keys()]))
          for (const [pathname, documents] of local) {
            for (const [id, reference] of documents) {
              if (ids.has(id)) found.get(pathname)!.set(`${collection.name}\u0000${id}`, reference)
            }
          }
        }))
        return { references: Object.fromEntries([...found].map(([pathname, documents]) => [pathname, [...documents.values()]])) }
      })
    },

    async mediaAccess(context): Promise<ViteHubConsoleMediaAccess> {
      // Media is shared by every collection, so it follows the widest access: anyone who may edit a collection may upload
      // for it. Moves and deletes change published documents without a publish, so they need publish access.
      const access = await Promise.all(content.collections().map(collection => Promise.all((["read", "write", "publish"] as const).map(action =>
        content.can({ user: context.user, collection: collection.name, action })))))
      return {
        read: access.some(([read]) => read),
        write: access.some(([read, write]) => read && write),
        manage: access.some(([read, write, publish]) => read && write && publish),
      }
    },

    async search(input, context) {
      if (!isRecord(input)) throw invalidInput("search() requires { query }.")
      const query = String(input.query) === input.query ? input.query.trim() : ""
      if (!query) throw invalidInput("query must be a non-empty string.")
      const limit = input.limit ?? 20
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumSearchLimit) throw invalidInput(`limit must be an integer from 1 to ${maximumSearchLimit}.`)
      const collections = await readable(context)
      const needle = query.toLowerCase()
      return await attempt(async () => {
        const found = await Promise.all(collections.map(async (collection) => {
          // The draft search covers the collection's search fields and the body; ids match as text too.
          const statuses = await readableStatusesOf(context, collection)
          const readable = statuses.filter(status => status.draft !== null).map(status => status.id)
          if (!readable.length) return []
          const page = await collection.list({ ref: "draft", search: query, filter: { id: readable }, limit })
          const byId = new Map(statuses.map(status => [status.id, status]))
          const items = new Map(page.items.map(item => [item.id, item]))
          const idMatches = statuses.filter(status => status.draft !== null && !items.has(status.id) && status.id.toLowerCase().includes(needle)).slice(0, limit)
          if (idMatches.length) {
            for (const [id, item] of await summaries(collection, new Set(idMatches.map(status => status.id)), byId)) items.set(id, item)
          }
          return [...items.values()].map((item) => {
            const title = titleOf(collection, item.data, item.id)
            const lower = title.toLowerCase()
            const rank = lower.startsWith(needle) ? 0 : lower.includes(needle) ? 1 : item.id.toLowerCase().includes(needle) ? 2 : 3
            const result: ViteHubConsoleDocumentSearchResult = { collection: collection.name, id: item.id, title, state: byId.get(item.id)?.state ?? "draft", updatedAt: item.updatedAt }
            return { rank, result }
          })
        }))
        const items = found.flat()
          .sort((left, right) => left.rank - right.rank || (right.result.updatedAt ?? "").localeCompare(left.result.updatedAt ?? ""))
          .slice(0, limit)
          .map(({ result }) => result)
        return { items }
      })
    },
  }
  return actions
}
