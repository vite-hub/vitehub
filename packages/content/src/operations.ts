import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import { compileDocumentsPath, parseDocumentFile, renderDocumentFile } from "./documents.ts"

import type { AnyOperation, OperationContext } from "@vite-hub/internal/operations"
import type {
  AnyContentCollection,
  ContentDocumentState,
  ContentDocumentStatus,
  ContentListOptions,
  ContentPublishOptions,
  ContentRawDocument,
  ContentRevisionsOptions,
  ContentWriteOptions,
} from "./collections-types.ts"
import type { ContentFieldIssue } from "./documents.ts"
import type { ContentAction, ContentDocumentsRuntime } from "./index.ts"
import type { ContentScheduleStatus } from "./schedules.ts"
import type {
  ContentDevCollection,
  ContentDevCollectionsResult,
  ContentDevDiffResult,
  ContentDevListResult,
  ContentDevPublishResult,
  ContentDevRevisionsResult,
  ContentDevSaveResult,
  ContentDevSchedulesResult,
  ContentDevShowResult,
  ContentDevSitemapResult,
  ContentDevStatusResult,
  ContentDevUnscheduleResult,
} from "./results.ts"

/** The parts of a `defineContent()` runtime that the operations use. */
type ContentOperationsRuntime = Pick<ContentDocumentsRuntime, "can" | "collection" | "collections" | "hasPolicy" | "head" | "publish" | "revisions" | "schedule" | "schedules" | "sitemap" | "unschedule">

const runtimeMembers = ["can", "collection", "collections", "publish", "revisions", "schedule", "schedules", "sitemap", "unschedule"]

const sectionModulesKey = Symbol.for("vitehub.console.section-modules")

/**
 * The `server/content.ts` module loaders that the Console installs, by section. Content operations read the `content`
 * export through it, so they run in a deployed app and in `vite dev` with the same file.
 */
type SectionModules = Record<string, (() => Promise<Record<string, unknown>>) | undefined>

function isRuntime(value: unknown): value is ContentOperationsRuntime {
  return value !== null && Object(value) === value && runtimeMembers.every(member => Reflect.get(Object(value), member) instanceof Function)
}

class ContentOperationError extends Error {
  readonly code: string
  readonly details?: unknown
  readonly fix?: string
  readonly status: number

  constructor(status: number, code: string, message: string, options: { details?: unknown, fix?: string } = {}) {
    super(message)
    this.code = code
    this.status = status
    if (options.details !== undefined) this.details = options.details
    if (options.fix) this.fix = options.fix
  }
}

const errorStatus = new Map([
  ["CONTENT_INVALID", 422],
  ["CONTENT_LEASE_HELD", 409],
  ["CONTENT_NOT_FOUND", 404],
  ["CONTENT_R0007", 409],
  ["CONTENT_R0008", 400],
  ["CONTENT_R0009", 400],
  ["CONTENT_R0011", 400],
  ["CONTENT_R0013", 409],
  ["WORKSPACE_CONFLICT", 409],
])

function errorCode(error: unknown): string | undefined {
  const code: unknown = Reflect.get(Object(error), "code")
  return String(code) === code ? code : undefined
}

/** Run Content work and give the errors of the runtime the status that every surface reports. */
async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  }
  catch (error) {
    const code = errorCode(error)
    const status = code === undefined ? undefined : errorStatus.get(code)
    if (status && Reflect.get(Object(error), "status") === undefined) Object.assign(Object(error), { status })
    throw error
  }
}

async function contentRuntime(): Promise<ContentOperationsRuntime> {
  const modules = Reflect.get(globalThis, sectionModulesKey) as SectionModules | undefined
  const load = modules?.content
  if (!load) {
    throw new ContentOperationError(409, "CONTENT_UNDEFINED", "This app has no server/content.ts, so there is no Content to work on.", { fix: "Create server/content.ts and export `content` from defineContent()." })
  }
  const content = (await load()).content
  if (!isRuntime(content)) {
    throw new ContentOperationError(409, "CONTENT_UNDEFINED", "server/content.ts does not export a defineContent() runtime named `content`.", { fix: "Export the result of defineContent() as `content`." })
  }
  return content
}

/**
 * `vite dev` has no sign-in for the CLI (the `local` access, or `open` when the app sets `console.auth: false`), so
 * `defineContent({ authorize })` cannot name a user. The dev RPC serves only loopback requests, and a production server
 * never gets this trust.
 */
function trusted(context: OperationContext): boolean {
  return context.surface === "cli" && (context.access.mode === "local" || context.access.mode === "open") && context.development === true
}

interface Guard {
  /** Throws `CONTENT_FORBIDDEN` when the policy denies the action. */
  allow(action: ContentAction, collection: string, id?: string): Promise<void>
  can(action: ContentAction, collection: string, id?: string): Promise<boolean>
  /** The ids the user may read. */
  readable(collection: string, ids: Iterable<string>): Promise<Set<string>>
}

function guard(content: ContentOperationsRuntime, context: OperationContext): Guard {
  const can = async (action: ContentAction, collection: string, id?: string): Promise<boolean> => {
    if (trusted(context)) return true
    return await content.can({
      action,
      collection,
      user: context.user,
      ...(context.actor ? { actor: context.actor as never } : {}),
      ...(id === undefined ? {} : { id }),
    })
  }
  return {
    can,
    async allow(action, collection, id) {
      if (await can(action, collection, id)) return
      throw new ContentOperationError(403, "CONTENT_FORBIDDEN", `You cannot ${action === "read" ? "read drafts of" : action === "write" ? "edit" : "publish"} this ${id === undefined ? "collection" : "document"}.`, {
        fix: content.hasPolicy ? "Ask for access, or allow the action in defineContent({ authorize })." : "Add authorize to defineContent(). Without a policy nobody can use Content outside `vite dev`.",
      })
    },
    async readable(collection, ids) {
      const list = [...new Set(ids)]
      const allowed = await Promise.all(list.map(id => can("read", collection, id)))
      return new Set(list.filter((_id, index) => allowed[index]))
    },
  }
}

/** Revisions carry the surface and the person or Agent that made them, as Console writes do. */
function metadata(context: OperationContext): Record<string, unknown> {
  const author = Object.fromEntries(["id", "name", "email"].flatMap((key) => {
    const value = context.user?.[key]
    return String(value) === value && value ? [[key, value]] : []
  }))
  return {
    source: context.surface,
    ...(Object.keys(author).length ? { author } : {}),
    ...(context.actor?.id ? { agent: { actor: context.actor.id } } : {}),
  }
}

/** Every document status of a collection, or the one status of a singleton. */
async function statusesOf(collection: AnyContentCollection): Promise<ContentDocumentStatus[]> {
  if (collection.kind === "documents") return await collection.status()
  const status = await collection.status()
  return status ? [status] : []
}

function titleOf(collection: AnyContentCollection, data: Record<string, unknown> | undefined, id: string): string {
  if (collection.kind === "singleton") return collection.label
  const title = collection.titleField && data ? data[collection.titleField] : undefined
  return String(title) === title && title.trim() ? title : id
}

function notFound(collection: string, id: string): ContentOperationError {
  return new ContentOperationError(404, "CONTENT_NOT_FOUND", `Content document ${JSON.stringify(`${collection}/${id}`)} exists on neither draft nor published.`)
}

function invalid(message: string, fix?: string): ContentOperationError {
  return new ContentOperationError(400, "CONTENT_R0014", message, fix ? { fix } : {})
}

/** The document id of the input. A singleton has one document, so its id may be omitted. */
function documentId(collection: AnyContentCollection, id: string | undefined, operation: string): string {
  if (id !== undefined) return id
  if (collection.kind === "singleton") return collection.id
  throw invalid(`The ${operation} operation requires a document id.`, "Pass the document id after the collection.")
}

async function readableCollections(content: ContentOperationsRuntime, access: Guard): Promise<AnyContentCollection[]> {
  const collections = content.collections()
  const allowed = await Promise.all(collections.map(async (collection) => {
    if (!await access.can("read", collection.name)) return false
    return collection.kind === "singleton" ? await access.can("read", collection.name, collection.id) : true
  }))
  return collections.filter((_collection, index) => allowed[index])
}

function selected(content: ContentOperationsRuntime, name: string | undefined): AnyContentCollection[] {
  return name === undefined ? content.collections() : [content.collection(name)]
}

const text = v.pipe(v.string(), v.minLength(1))
const optionalText = v.optional(text)
const ref = v.picklist(["draft", "published"])
const digest = v.nullable(text)
const expectation = v.object({ collection: text, digest, id: text })
const expectations = v.pipe(v.array(expectation), v.minLength(1))
const limit = v.pipe(v.number(), v.integer(), v.minValue(1))

const pendingChange = { draft: "add", changed: "update", deleted: "delete" } as const

const collections = defineOperation({
  cli: { command: "collections" },
  description: "List collections and singletons with their fields and document counts.",
  input: v.strictObject({}),
  kind: "read",
  name: "content.collections",
  run: async (_input, context): Promise<ContentDevCollectionsResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const visible = await readableCollections(content, access)
    return {
      collections: await Promise.all(visible.map(async (collection): Promise<ContentDevCollection> => {
        const statuses = await statusesOf(collection)
        const readable = await access.readable(collection.name, statuses.map(status => status.id))
        const states: Record<ContentDocumentState, number> = { draft: 0, published: 0, changed: 0, deleted: 0 }
        let documents = 0
        for (const status of statuses) {
          if (!readable.has(status.id)) continue
          states[status.state]++
          documents++
        }
        const entry: ContentDevCollection = {
          documents,
          fields: [...collection.fields],
          format: collection.format,
          kind: collection.kind,
          label: collection.label,
          name: collection.name,
          path: collection.path,
          states,
        }
        if (collection.titleField) entry.titleField = collection.titleField
        if (collection.kind === "singleton") entry.id = collection.id
        return entry
      })),
    }
  }),
  section: "content",
})

const list = defineOperation({
  cli: { command: "list", positional: ["collection"] },
  description: "List the documents of a collection with their state, title, and field issues. Reads the draft unless ref is published.",
  input: v.strictObject({ collection: text, cursor: optionalText, limit: v.optional(limit), ref: v.optional(ref), search: optionalText }),
  kind: "read",
  name: "content.list",
  run: async (input, context): Promise<ContentDevListResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const collection = content.collection(input.collection)
    await access.allow("read", collection.name)
    const selectedRef = input.ref ?? "draft"
    const options: ContentListOptions = { limit: input.limit ?? 50, ref: selectedRef }
    if (input.search !== undefined) options.search = input.search
    if (input.cursor !== undefined) options.cursor = input.cursor
    const statuses = await statusesOf(collection)
    const byId = new Map(statuses.map(status => [status.id, status]))
    const readable = await access.readable(collection.name, byId.keys())
    if (!readable.size) return { collection: collection.name, items: [], ref: selectedRef, total: 0 }
    options.filter = { id: [...readable] }
    const page = await collection.list(options)
    const result: ContentDevListResult = {
      collection: collection.name,
      items: page.items.map((item) => {
        const status = byId.get(item.id)
        const entry: ContentDevListResult["items"][number] = {
          id: item.id,
          state: status?.state ?? (selectedRef === "draft" ? "draft" : "published"),
          title: titleOf(collection, item.data, item.id),
          updatedAt: item.updatedAt,
        }
        if (selectedRef === "draft" && status?.issues) entry.issues = status.issues
        if (item.url !== undefined) entry.url = item.url
        return entry
      }),
      ref: selectedRef,
      total: page.total,
    }
    if (page.nextCursor) result.cursor = page.nextCursor
    return result
  }),
  section: "content",
})

/** `/blog/hello/` and `/blog/hello` are the same page. */
function normalizeUrl(value: string): string {
  const path = value.split(/[?#]/, 1)[0] ?? value
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path
}

/**
 * A conservative prefilter over normalized paths. Tokens may be empty or contain slashes, so only the literal prefix
 * before the first token is safe to require; the generated URL index decides the match. Functions can produce any path.
 */
function routePattern(collection: AnyContentCollection): RegExp | null {
  if (collection.urlPattern === undefined) return null
  const pattern = normalizeUrl(collection.urlPattern)
  const token = /:[A-Za-z_$][\w$]*/.exec(pattern)
  const prefix = token ? normalizeUrl(pattern.slice(0, token.index)) : pattern
  const source = prefix.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&")
  return new RegExp(`^${source}${token ? "" : "$"}`)
}

/** Paths of the documents of one collection, as of one draft head. Rebuilt only when the head moves. */
interface PathIndex {
  byPath: Map<string, string>
  head: string
}

const pathIndexes = new WeakMap<object, Map<string, PathIndex>>()

/** Every document of the collection with a URL, from full pages of summaries (no bodies). One list per head. */
async function pathIndexOf(content: ContentOperationsRuntime, collection: AnyContentCollection): Promise<Map<string, string>> {
  // A stand-in runtime without head() builds the index each time.
  const head = await (content as Partial<Pick<ContentOperationsRuntime, "head">>).head?.("draft") ?? null
  const cached = pathIndexes.get(content)?.get(collection.name)
  if (head !== null && cached?.head === head) return cached.byPath
  const byPath = new Map<string, string>()
  let cursor: string | undefined
  do {
    const page = await collection.list({ limit: 1_000, ref: "draft", ...(cursor === undefined ? {} : { cursor }) })
    for (const item of page.items) if (item.url !== undefined && item.url !== null) byPath.set(normalizeUrl(item.url), item.id)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  if (head !== null) {
    const indexes = pathIndexes.get(content) ?? new Map<string, PathIndex>()
    indexes.set(collection.name, { byPath, head })
    pathIndexes.set(content, indexes)
  }
  return byPath
}

const resolveDocument = defineOperation({
  cli: { command: "resolve", positional: ["path"] },
  description: "Find the document whose public URL is a path, for the Edit button of the comments overlay. Null when no readable document has it.",
  input: v.strictObject({ path: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)) }),
  kind: "read",
  name: "content.resolve",
  run: async (input, context): Promise<{ collection: string, id: string } | null> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const wanted = normalizeUrl(input.path)
    // A collection whose `url` pattern cannot produce the path is not listed at all.
    const candidates = (await readableCollections(content, access)).filter(collection => collection.routable && (routePattern(collection)?.test(wanted) ?? true))
    for (const collection of candidates) {
      const id = (await pathIndexOf(content, collection)).get(wanted)
      if (id !== undefined && (await access.readable(collection.name, [id])).has(id)) return { collection: collection.name, id }
    }
    return null
  }),
  section: "content",
})

/** The field issues of a stored document: `issues` of a draft, or the `CONTENT_INVALID` details of any other read. */
async function issuesOf(collection: AnyContentCollection, id: string, selectedRef: "draft" | "published"): Promise<ContentFieldIssue[] | undefined> {
  try {
    return (await collection.get(id, { ref: selectedRef }))?.issues
  }
  catch (error) {
    if (errorCode(error) !== "CONTENT_INVALID") throw error
    const issues: unknown = Reflect.get(Object(Reflect.get(Object(error), "details")), "issues")
    // SAFETY: Content puts the ContentFieldIssue list of the invalid document in `details.issues`.
    return Array.isArray(issues) ? issues as ContentFieldIssue[] : undefined
  }
}

/** The file a new document gets: every field as null. Drafts accept it, and the save reports what to fill in. */
function documentTemplate(collection: AnyContentCollection, id: string): { path: string, text: string } {
  const path = collection.kind === "singleton"
    ? collection.path
    : (({ base, extension }) => `${base}${id}${extension}`)(compileDocumentsPath(collection.path))
  return { path, text: renderDocumentFile(Object.fromEntries(collection.fields.map(field => [field, null])), "", collection.format) }
}

const show = defineOperation({
  cli: { command: "show", positional: ["collection", "id"] },
  description: "Print the stored file of one document, frontmatter included, and its field issues. Omit the id for a singleton.",
  input: v.strictObject({ collection: text, create: v.optional(v.boolean()), id: optionalText, ref: v.optional(ref) }),
  kind: "read",
  name: "content.show",
  run: async (input, context): Promise<ContentDevShowResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const collection = content.collection(input.collection)
    const id = documentId(collection, input.id, "show")
    await access.allow("read", collection.name, id)
    const selectedRef = input.ref ?? "draft"
    const [raw, status] = await Promise.all([collection.raw(id, { ref: selectedRef }), collection.status(id)])
    if (!raw) {
      if (!input.create || selectedRef !== "draft") throw notFound(collection.name, id)
      return { collection: collection.name, digest: null, id, ref: selectedRef, ...documentTemplate(collection, id), status }
    }
    const result: ContentDevShowResult = { collection: collection.name, digest: raw.digest, id, path: raw.path, ref: selectedRef, status, text: raw.text }
    const issues = await issuesOf(collection, id, selectedRef)
    if (issues?.length) result.issues = issues
    return result
  }),
  section: "content",
})

const status = defineOperation({
  cli: { command: "status", positional: ["collection", "id"] },
  description: "Show whether each document is draft, published, changed, or deleted, with field issues and schedules.",
  input: v.strictObject({ collection: optionalText, id: optionalText }),
  kind: "read",
  name: "content.status",
  run: async (input, context): Promise<ContentDevStatusResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    if (input.id !== undefined) {
      if (input.collection === undefined) throw invalid("Status of one document needs its collection.", "Pass the collection before the id.")
      const collection = content.collection(input.collection)
      await access.allow("read", collection.name, input.id)
      const one = await collection.status(input.id)
      if (!one) throw notFound(collection.name, input.id)
      return { documents: [one] }
    }
    const documents: ContentDocumentStatus[] = []
    for (const collection of selected(content, input.collection)) {
      if (!await access.can("read", collection.name)) continue
      const statuses = await statusesOf(collection)
      const readable = await access.readable(collection.name, statuses.map(entry => entry.id))
      documents.push(...statuses.filter(entry => readable.has(entry.id)))
    }
    return { documents }
  }),
  section: "content",
})

function diffSide(raw: ContentRawDocument | null): { digest: string, text: string } | null {
  return raw ? { digest: raw.digest, text: raw.text } : null
}

const diff = defineOperation({
  cli: { command: "diff", positional: ["collection", "id"] },
  description: "Read both stored files of one document, published and draft, to compare them. Omit the id for a singleton.",
  input: v.strictObject({ collection: text, id: optionalText }),
  kind: "read",
  name: "content.diff",
  run: async (input, context): Promise<ContentDevDiffResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const collection = content.collection(input.collection)
    const id = documentId(collection, input.id, "diff")
    await access.allow("read", collection.name, id)
    // raw() returns the stored file even when it no longer validates, so a diff can show what to repair.
    const [state, published, draft] = await Promise.all([
      collection.status(id),
      collection.raw(id, { ref: "published" }),
      collection.raw(id, { ref: "draft" }),
    ])
    const path = draft?.path ?? published?.path
    if (!state || !path) throw notFound(collection.name, id)
    return { collection: collection.name, draft: diffSide(draft), id, path, published: diffSide(published), state: state.state }
  }),
  section: "content",
})

const revisions = defineOperation({
  cli: { command: "revisions", positional: ["collection", "id"] },
  description: "List the revisions that saved, removed, restored, or published one document, newest first.",
  input: v.strictObject({ collection: text, cursor: optionalText, id: optionalText, limit: v.optional(limit), ref: v.optional(ref) }),
  kind: "read",
  name: "content.revisions",
  run: async (input, context): Promise<ContentDevRevisionsResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const collection = content.collection(input.collection)
    const id = documentId(collection, input.id, "revisions")
    await access.allow("read", collection.name, id)
    const selectedRef = input.ref ?? "draft"
    const options: ContentRevisionsOptions = { ref: selectedRef }
    if (input.limit !== undefined) options.limit = input.limit
    if (input.cursor !== undefined) options.cursor = input.cursor
    const page = await content.revisions(collection.name, id, options)
    const result: ContentDevRevisionsResult = { collection: collection.name, id, ref: selectedRef, revisions: page.revisions }
    if (page.cursor) result.cursor = page.cursor
    return result
  }),
  section: "content",
})

const save = defineOperation({
  cli: { command: "edit", positional: ["collection", "id"] },
  description: "Save the whole stored file of one document to the draft. Fails while someone else holds the edit lease, unless lease is override.",
  input: v.strictObject({
    collection: text,
    id: optionalText,
    ifDigest: v.optional(digest),
    lease: v.optional(v.literal("override")),
    message: optionalText,
    text: v.string(),
  }),
  kind: "write",
  maxRequestBytes: 1024 * 1024 + 64 * 1024,
  name: "content.save",
  run: async (input, context): Promise<ContentDevSaveResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const collection = content.collection(input.collection)
    const id = documentId(collection, input.id, "save")
    await access.allow("write", collection.name, id)
    if (input.lease === "override" && context.surface === "agent" && !context.overrideLeases) {
      throw new ContentOperationError(403, "CONTENT_FORBIDDEN", "An Agent may not take over a document that a person is editing.", { fix: "Create the capability with operations({ overrideLeases: true }) if Agents may write over an edit lease." })
    }
    const parsed = parseDocumentFile(input.text, collection.format)
    if (!("frontmatter" in parsed)) {
      throw new ContentOperationError(422, "CONTENT_INVALID", `Content document ${JSON.stringify(`${collection.name}/${id}`)} cannot be read as ${collection.format}.`, { details: { collection: collection.name, id, issues: parsed.issues } })
    }
    const options: ContentWriteOptions = { metadata: metadata(context) }
    if (input.ifDigest !== undefined) options.ifDigest = input.ifDigest
    if (input.message !== undefined) options.message = input.message
    if (input.lease !== undefined) options.lease = input.lease
    const document = await collection.save(id, { body: parsed.body, data: parsed.frontmatter }, options)
    const result: ContentDevSaveResult = { collection: document.collection, digest: document.digest, id: document.id, path: document.path, revision: document.revision }
    if (document.issues?.length) result.issues = document.issues
    return result
  }),
  section: "content",
})

/**
 * A dry run selects documents by `collection` and `ids` and lists each pending change with its draft digest. A publish
 * takes those digests back as `expect`, so it publishes exactly what the user confirmed, or nothing.
 */
const publish = defineOperation({
  cli: { command: "publish" },
  description: "Publish the listed draft documents in one revision, pinned to the digests of a dry run. A draft saved after the dry run fails the publish.",
  input: v.strictObject({
    collection: optionalText,
    dryRun: v.optional(v.boolean()),
    expect: v.optional(expectations),
    ids: v.optional(v.pipe(v.array(text), v.minLength(1))),
    message: optionalText,
  }),
  kind: "destructive",
  name: "content.publish",
  readOnlyWhen: input => input.dryRun === true,
  run: async (input, context): Promise<ContentDevPublishResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    if (input.dryRun) {
      if (input.expect !== undefined) throw invalid("A publish dry run selects documents with collection and ids, not expect.")
      if (input.ids !== undefined && input.collection === undefined) throw invalid("Publishing documents by id requires a collection.")
      const documents: ContentDevPublishResult["documents"] = []
      for (const collection of selected(content, input.collection)) {
        if (!await access.can("read", collection.name)) continue
        const statuses = input.ids === undefined
          ? await statusesOf(collection)
          : await Promise.all(input.ids.map(async (id) => {
              const found = await collection.status(id)
              if (!found) throw notFound(collection.name, id)
              return found
            }))
        const readable = await access.readable(collection.name, statuses.map(entry => entry.id))
        for (const entry of statuses) {
          if (entry.state === "published" || !readable.has(entry.id)) continue
          const document: ContentDevPublishResult["documents"][number] = { change: pendingChange[entry.state], collection: entry.collection, digest: entry.draft, id: entry.id }
          if (entry.issues) document.issues = entry.issues
          documents.push(document)
        }
      }
      return { documents, dryRun: true, revision: null }
    }
    if (input.expect === undefined) throw invalid("A publish needs expect: the draft digests from a dry run that the user confirmed.", "Run it with dryRun first, then send the digests it listed as expect.")
    if (input.collection !== undefined || input.ids !== undefined) throw invalid("A publish names its documents in expect. Do not combine it with collection or ids.")
    for (const document of input.expect) await access.allow("publish", document.collection, document.id)
    const options: ContentPublishOptions = { expect: input.expect, metadata: metadata(context) }
    if (input.message !== undefined) options.message = input.message
    const result = await content.publish(options)
    return { documents: result.documents, dryRun: false, revision: result.revision }
  }),
  section: "content",
})

const schedule = defineOperation({
  cli: { command: "schedule" },
  description: "Publish the listed draft documents at a later time, pinned to the digests of a dry run. A Schedule Definition that calls content.publishDue() runs it.",
  input: v.strictObject({ at: text, expect: expectations, message: optionalText }),
  kind: "destructive",
  name: "content.schedule",
  run: async (input, context) => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    for (const document of input.expect) await access.allow("publish", document.collection, document.id)
    return await content.schedule({ at: input.at, expect: input.expect, metadata: metadata(context), ...(input.message === undefined ? {} : { message: input.message }) })
  }),
  section: "content",
})

const unschedule = defineOperation({
  cli: { command: "unschedule", positional: ["schedule"] },
  description: "Cancel a pending schedule, or dismiss a failed one.",
  input: v.strictObject({ schedule: text }),
  kind: "destructive",
  name: "content.unschedule",
  run: async (input, context): Promise<ContentDevUnscheduleResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const found = (await content.schedules()).find(entry => entry.id === input.schedule)
    if (!found) throw new ContentOperationError(404, "CONTENT_NOT_FOUND", `No schedule ${JSON.stringify(input.schedule)}. It already ran or was cancelled.`)
    // Cancelling decides what gets published, so it needs publish access to every document of the schedule.
    for (const document of found.expect) await access.allow("publish", document.collection, document.id)
    await content.unschedule(input.schedule, { metadata: metadata(context) })
    return { schedule: input.schedule }
  }),
  section: "content",
})

const schedules = defineOperation({
  cli: { command: "scheduled", positional: ["collection", "id"] },
  description: "List pending, overdue, and failed schedules, earliest first.",
  input: v.strictObject({ collection: optionalText, id: optionalText, status: v.optional(v.picklist(["pending", "overdue", "failed"] satisfies ContentScheduleStatus[])) }),
  kind: "read",
  name: "content.schedules",
  run: async (input, context): Promise<ContentDevSchedulesResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    if (input.id !== undefined && input.collection === undefined) throw invalid("Schedules of one document need its collection.", "Pass the collection before the id.")
    const collection = input.collection === undefined ? undefined : content.collection(input.collection)
    const id = collection && input.id === undefined && collection.kind === "singleton" ? collection.id : input.id
    const found = await content.schedules({
      ...(collection ? { collection: collection.name } : {}),
      ...(id === undefined ? {} : { id }),
      ...(input.status === undefined ? {} : { status: input.status }),
    })
    // Show a schedule only when the user may enumerate each collection and read every document it publishes.
    const readable = new Map<string, Set<string>>()
    for (const name of new Set(found.flatMap(entry => entry.expect.map(document => document.collection)))) {
      if (!await access.can("read", name)) continue
      readable.set(name, await access.readable(name, found.flatMap(entry => entry.expect.filter(document => document.collection === name).map(document => document.id))))
    }
    return { schedules: found.filter(entry => entry.expect.every(document => readable.get(document.collection)?.has(document.id))) }
  }),
  section: "content",
})

const sitemap = defineOperation({
  cli: { command: "sitemap" },
  description: "List the sitemap URLs of published documents of collections with a url.",
  input: v.strictObject({ site: optionalText }),
  kind: "read",
  name: "content.sitemap",
  run: async (input, context): Promise<ContentDevSitemapResult> => attempt(async () => {
    const content = await contentRuntime()
    const access = guard(content, context)
    const entries = await content.sitemap(input.site === undefined ? {} : { site: input.site })
    const allowed = await Promise.all(entries.map(async entry => await access.can("read", entry.collection) && await access.can("read", entry.collection, entry.id)))
    return { entries: entries.filter((_entry, index) => allowed[index]) }
  }),
  section: "content",
})

/** The Content operations. The Console, `vitehub content`, and agents call them. `content.can()` is the policy. */
export const contentOperations: readonly AnyOperation[] = [collections, list, resolveDocument, show, status, diff, revisions, save, publish, schedule, unschedule, schedules, sitemap]
