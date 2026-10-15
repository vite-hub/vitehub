import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText } from "@vite-hub/internal/inspect"

import { contentDevHeader, contentDevHeaderValue, isContentDevOperation } from "../dev.ts"
import { compileDocumentsPath, parseDocumentFile, renderDocumentFile } from "../documents.ts"

import type {
  AnyContentCollection,
  ContentDocumentState,
  ContentDocumentStatus,
  ContentListOptions,
  ContentPublishExpectation,
  ContentPublishOptions,
  ContentRawDocument,
  ContentRevisionsOptions,
  ContentWriteOptions,
} from "../collections.ts"
import type { ContentFieldIssue } from "../documents.ts"
import type { ContentDocumentsRuntime } from "../index.ts"
import type { ContentScheduleStatus } from "../schedules.ts"
import type {
  ContentDevCollection,
  ContentDevCollectionsResult,
  ContentDevDiffResult,
  ContentDevDiffSide,
  ContentDevListResult,
  ContentDevPublishResult,
  ContentDevRequestBody,
  ContentDevRevisionsResult,
  ContentDevSaveResult,
  ContentDevSchedulesResult,
  ContentDevShowResult,
  ContentDevSitemapResult,
  ContentDevStatusResult,
  ContentDevUnscheduleResult,
} from "../dev.ts"

/** The parts of a `defineContent()` runtime that the dev endpoint uses. */
type ContentDevRuntime = Pick<ContentDocumentsRuntime, "collection" | "collections" | "publish" | "revisions" | "schedule" | "schedules" | "sitemap" | "unschedule">

class ContentDevRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message)
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

const scheduleStatuses: ReadonlySet<string> = new Set<ContentScheduleStatus>(["pending", "overdue", "failed"])

/** Revisions that the CLI writes carry this source, as Console writes carry `console`. */
const cliMetadata = { source: "cli" }

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function failure(message: string, status: number, code?: string, details?: unknown): Response {
  const error: { code?: string, details?: unknown, message: string } = { message: redactInspectionText(message) }
  if (code) error.code = code
  if (details !== undefined) error.details = details
  return json({ error }, status)
}

function isContentRuntime(value: unknown): value is ContentDevRuntime {
  return value !== null && Object(value) === value
    && ["collections", "collection", "publish", "revisions", "schedule", "schedules", "sitemap", "unschedule"]
      .every(method => Reflect.get(Object(value), method) instanceof Function)
}

function invalidRequest(message: string): ContentDevRequestError {
  return new ContentDevRequestError(message, 400)
}

function readString(body: Record<string, unknown>, name: string): string | undefined {
  const value: unknown = body[name]
  if (value === undefined) return
  if (String(value) !== value || !value) throw invalidRequest(`${name} must be a nonempty string.`)
  return value
}

function readBody(value: unknown): ContentDevRequestBody {
  if (value === null || Object(value) !== value || Array.isArray(value)) throw invalidRequest("The Content Dev request body is invalid.")
  // SAFETY: The guard above admits only non-array objects.
  const body = value as Record<string, unknown>
  if (!isContentDevOperation(body.operation)) throw invalidRequest("The Content Dev request body is invalid.")
  const parsed: ContentDevRequestBody = { operation: body.operation }
  for (const name of ["at", "collection", "cursor", "id", "message", "schedule", "search", "site"] as const) {
    const string = readString(body, name)
    if (string !== undefined) parsed[name] = string
  }
  if (body.ref !== undefined) {
    if (body.ref !== "draft" && body.ref !== "published") throw invalidRequest("ref must be \"draft\" or \"published\".")
    parsed.ref = body.ref
  }
  if (body.limit !== undefined) {
    if (!Number.isSafeInteger(body.limit) || Number(body.limit) < 1) throw invalidRequest("limit must be a positive integer.")
    parsed.limit = Number(body.limit)
  }
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.some(id => String(id) !== id || !id)) {
      throw invalidRequest("ids must be a non-empty list of document ids.")
    }
    parsed.ids = body.ids.map(String)
  }
  for (const name of ["create", "dryRun"] as const) {
    if (body[name] === undefined) continue
    if (body[name] !== true && body[name] !== false) throw invalidRequest(`${name} must be a boolean.`)
    parsed[name] = body[name]
  }
  if (body.text !== undefined) {
    if (String(body.text) !== body.text) throw invalidRequest("text must be a string.")
    parsed.text = body.text
  }
  if (body.ifDigest !== undefined) {
    if (body.ifDigest !== null && (String(body.ifDigest) !== body.ifDigest || !body.ifDigest)) throw invalidRequest("ifDigest must be a digest or null.")
    parsed.ifDigest = body.ifDigest
  }
  if (body.lease !== undefined) {
    if (body.lease !== "override") throw invalidRequest("lease must be \"override\".")
    parsed.lease = body.lease
  }
  if (body.status !== undefined) {
    if (String(body.status) !== body.status || !scheduleStatuses.has(body.status)) throw invalidRequest("status must be pending, overdue, or failed.")
    // SAFETY: Membership in scheduleStatuses proves the literal.
    parsed.status = body.status as ContentScheduleStatus
  }
  if (body.expect !== undefined) parsed.expect = readExpect(body.expect)
  return parsed
}

function readExpect(value: unknown): ContentPublishExpectation[] {
  const invalid = () => invalidRequest("expect must be a non-empty list of { collection, id, digest }, with digest a string or null.")
  if (!Array.isArray(value) || !value.length) throw invalid()
  return value.map((entry: unknown) => {
    if (entry === null || Object(entry) !== entry) throw invalid()
    const collection: unknown = Reflect.get(Object(entry), "collection")
    const id: unknown = Reflect.get(Object(entry), "id")
    const digest: unknown = Reflect.get(Object(entry), "digest")
    if (String(collection) !== collection || !collection || String(id) !== id || !id) throw invalid()
    if (digest !== null && (String(digest) !== digest || !digest)) throw invalid()
    return { collection, id, digest }
  })
}

function requireCollection(content: ContentDevRuntime, body: ContentDevRequestBody): AnyContentCollection {
  if (body.collection === undefined) throw invalidRequest(`The ${body.operation} operation requires a collection.`)
  return content.collection(body.collection)
}

/** The document id of the request. A singleton has one document, so its id may be omitted. */
function documentId(collection: AnyContentCollection, body: ContentDevRequestBody): string {
  if (body.id !== undefined) return body.id
  if (collection.kind === "singleton") return collection.id
  throw invalidRequest(`The ${body.operation} operation requires a document id.`)
}

function notFound(collection: string, id: string): ContentDevRequestError {
  return new ContentDevRequestError(`Content document ${JSON.stringify(`${collection}/${id}`)} exists on neither draft nor published.`, 404, "CONTENT_NOT_FOUND")
}

/** Every document status of a collection, or the one status of a singleton. */
async function statusesOf(collection: AnyContentCollection): Promise<ContentDocumentStatus[]> {
  if (collection.kind === "documents") return await collection.status()
  const status = await collection.status()
  return status ? [status] : []
}

function selectedCollections(content: ContentDevRuntime, name: string | undefined): AnyContentCollection[] {
  return name === undefined ? content.collections() : [content.collection(name)]
}

/** The name of a document: a singleton's label, else its title field, else its id. */
function titleOf(collection: AnyContentCollection, data: Record<string, unknown> | undefined, id: string): string {
  if (collection.kind === "singleton") return collection.label
  const title = collection.titleField && data ? data[collection.titleField] : undefined
  return String(title) === title && title.trim() ? title : id
}

function errorCode(error: unknown): string | undefined {
  const code: unknown = Reflect.get(Object(error), "code")
  return String(code) === code ? code : undefined
}

async function listCollections(content: ContentDevRuntime): Promise<ContentDevCollectionsResult> {
  const collections = await Promise.all(content.collections().map(async (collection): Promise<ContentDevCollection> => {
    const statuses = await statusesOf(collection)
    const states: Record<ContentDocumentState, number> = { draft: 0, published: 0, changed: 0, deleted: 0 }
    for (const status of statuses) states[status.state]++
    const entry: ContentDevCollection = {
      name: collection.name,
      kind: collection.kind,
      label: collection.label,
      path: collection.path,
      format: collection.format,
      fields: [...collection.fields],
      documents: statuses.length,
      states,
    }
    if (collection.titleField) entry.titleField = collection.titleField
    if (collection.kind === "singleton") entry.id = collection.id
    return entry
  }))
  return { collections }
}

async function listDocuments(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevListResult> {
  const collection = requireCollection(content, body)
  const ref = body.ref ?? "draft"
  const options: ContentListOptions = { ref, limit: body.limit ?? 50 }
  if (body.search !== undefined) options.search = body.search
  if (body.cursor !== undefined) options.cursor = body.cursor
  const [page, statuses] = await Promise.all([collection.list(options), statusesOf(collection)])
  const byId = new Map(statuses.map(status => [status.id, status]))
  const result: ContentDevListResult = {
    collection: collection.name,
    ref,
    total: page.total,
    items: page.items.map((item) => {
      const status = byId.get(item.id)
      const entry: ContentDevListResult["items"][number] = {
        id: item.id,
        title: titleOf(collection, item.data, item.id),
        state: status?.state ?? (ref === "draft" ? "draft" : "published"),
        updatedAt: item.updatedAt,
      }
      if (ref === "draft" && status?.issues) entry.issues = status.issues
      if (item.url !== undefined) entry.url = item.url
      return entry
    }),
  }
  if (page.nextCursor) result.cursor = page.nextCursor
  return result
}

/** The field issues of a stored document: `issues` of a draft, or the `CONTENT_INVALID` details of any other read. */
async function issuesOf(collection: AnyContentCollection, id: string, ref: "draft" | "published"): Promise<ContentFieldIssue[] | undefined> {
  try {
    return (await collection.get(id, { ref }))?.issues
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

async function showDocument(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevShowResult> {
  const collection = requireCollection(content, body)
  const id = documentId(collection, body)
  const ref = body.ref ?? "draft"
  const [raw, status] = await Promise.all([collection.raw(id, { ref }), collection.status(id)])
  if (!raw) {
    if (!body.create || ref !== "draft") throw notFound(collection.name, id)
    return { collection: collection.name, id, ref, ...documentTemplate(collection, id), digest: null, status }
  }
  const result: ContentDevShowResult = { collection: collection.name, id, path: raw.path, ref, text: raw.text, digest: raw.digest, status }
  const issues = await issuesOf(collection, id, ref)
  if (issues?.length) result.issues = issues
  return result
}

/** Save the whole stored file to the draft. Invalid fields are saved and returned as issues, as `save()` does. */
async function saveDocument(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevSaveResult> {
  const collection = requireCollection(content, body)
  const id = documentId(collection, body)
  if (body.text === undefined) throw invalidRequest("A save needs text: the whole document file.")
  const parsed = parseDocumentFile(body.text, collection.format)
  if (!("frontmatter" in parsed)) {
    throw new ContentDevRequestError(`Content document ${JSON.stringify(`${collection.name}/${id}`)} cannot be read as ${collection.format}.`, 422, "CONTENT_INVALID", { collection: collection.name, id, issues: parsed.issues })
  }
  const options: ContentWriteOptions = { metadata: cliMetadata }
  if (body.ifDigest !== undefined) options.ifDigest = body.ifDigest
  if (body.message !== undefined) options.message = body.message
  if (body.lease !== undefined) options.lease = body.lease
  const document = await collection.save(id, { data: parsed.frontmatter, body: parsed.body }, options)
  const result: ContentDevSaveResult = { collection: document.collection, id: document.id, path: document.path, digest: document.digest, revision: document.revision }
  if (document.issues?.length) result.issues = document.issues
  return result
}

async function readStatus(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevStatusResult> {
  if (body.id !== undefined) {
    const collection = requireCollection(content, body)
    const status = await collection.status(body.id)
    if (!status) throw notFound(collection.name, body.id)
    return { documents: [status] }
  }
  const documents = await Promise.all(selectedCollections(content, body.collection).map(statusesOf))
  return { documents: documents.flat() }
}

function diffSide(raw: ContentRawDocument | null): ContentDevDiffSide | null {
  return raw ? { digest: raw.digest, text: raw.text } : null
}

async function readDiff(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevDiffResult> {
  const collection = requireCollection(content, body)
  const id = documentId(collection, body)
  // raw() returns the stored file even when it no longer validates, so a diff can show what to repair.
  const [status, published, draft] = await Promise.all([
    collection.status(id),
    collection.raw(id, { ref: "published" }),
    collection.raw(id, { ref: "draft" }),
  ])
  const path = draft?.path ?? published?.path
  if (!status || !path) throw notFound(collection.name, id)
  return { collection: collection.name, id, path, state: status.state, published: diffSide(published), draft: diffSide(draft) }
}

async function readRevisions(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevRevisionsResult> {
  const collection = requireCollection(content, body)
  const id = documentId(collection, body)
  const ref = body.ref ?? "draft"
  const options: ContentRevisionsOptions = { ref }
  if (body.limit !== undefined) options.limit = body.limit
  if (body.cursor !== undefined) options.cursor = body.cursor
  const page = await content.revisions(collection.name, id, options)
  const result: ContentDevRevisionsResult = { collection: collection.name, id, ref, revisions: page.revisions }
  if (page.cursor) result.cursor = page.cursor
  return result
}

const pendingChange = { draft: "add", changed: "update", deleted: "delete" } as const

/**
 * A dry run selects documents by `collection` and `ids` and lists each pending change with its draft digest. A publish
 * takes those digests back as `expect`, so it publishes exactly what the user confirmed, or nothing.
 */
async function publish(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevPublishResult> {
  if (body.dryRun) {
    if (body.expect !== undefined) throw invalidRequest("A publish dry run selects documents with collection and ids, not expect.")
    if (body.ids !== undefined && body.collection === undefined) throw invalidRequest("Publishing documents by id requires a collection.")
    const documents: ContentDevPublishResult["documents"] = []
    for (const collection of selectedCollections(content, body.collection)) {
      const statuses = body.ids === undefined
        ? await statusesOf(collection)
        : await Promise.all(body.ids.map(async (id) => {
            const status = await collection.status(id)
            if (!status) throw notFound(collection.name, id)
            return status
          }))
      for (const status of statuses) {
        if (status.state === "published") continue
        const document: ContentDevPublishResult["documents"][number] = { collection: status.collection, id: status.id, change: pendingChange[status.state], digest: status.draft }
        if (status.issues) document.issues = status.issues
        documents.push(document)
      }
    }
    return { dryRun: true, revision: null, documents }
  }
  if (body.expect === undefined) {
    throw invalidRequest("A publish needs expect: the draft digests from a dry run that the user confirmed.")
  }
  if (body.collection !== undefined || body.ids !== undefined) {
    throw invalidRequest("A publish names its documents in expect. Do not combine it with collection or ids.")
  }
  const options: ContentPublishOptions = { expect: body.expect, metadata: cliMetadata }
  if (body.message !== undefined) options.message = body.message
  const result = await content.publish(options)
  return { dryRun: false, revision: result.revision, documents: result.documents }
}

async function schedule(content: ContentDevRuntime, body: ContentDevRequestBody) {
  if (body.expect === undefined) throw invalidRequest("A schedule needs expect: the draft digests from a dry run that the user confirmed.")
  if (body.at === undefined) throw invalidRequest("A schedule needs at: an ISO timestamp with a time zone.")
  return await content.schedule({ at: body.at, expect: body.expect, metadata: cliMetadata, ...(body.message === undefined ? {} : { message: body.message }) })
}

async function unschedule(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevUnscheduleResult> {
  if (body.schedule === undefined) throw invalidRequest("An unschedule needs the schedule id.")
  await content.unschedule(body.schedule, { metadata: cliMetadata })
  return { schedule: body.schedule }
}

async function listSchedules(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevSchedulesResult> {
  if (body.id !== undefined && body.collection === undefined) throw invalidRequest("Schedules of one document need its collection.")
  const collection = body.collection === undefined ? undefined : content.collection(body.collection)
  const id = collection && body.id === undefined && collection.kind === "singleton" ? collection.id : body.id
  return {
    schedules: await content.schedules({
      ...(collection ? { collection: collection.name } : {}),
      ...(id === undefined ? {} : { id }),
      ...(body.status === undefined ? {} : { status: body.status }),
    }),
  }
}

async function sitemap(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevSitemapResult> {
  return { entries: await content.sitemap(body.site === undefined ? {} : { site: body.site }) }
}

async function runOperation(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<unknown> {
  switch (body.operation) {
    case "collections": return await listCollections(content)
    case "list": return await listDocuments(content, body)
    case "show": return await showDocument(content, body)
    case "status": return await readStatus(content, body)
    case "diff": return await readDiff(content, body)
    case "revisions": return await readRevisions(content, body)
    case "save": return await saveDocument(content, body)
    case "publish": return await publish(content, body)
    case "schedule": return await schedule(content, body)
    case "unschedule": return await unschedule(content, body)
    case "schedules": return await listSchedules(content, body)
    case "sitemap": return await sitemap(content, body)
  }
}

/**
 * Handles one Content operation from `vitehub content`. The Vite Development Server forwards the request into the
 * Nitro runtime, so the operation uses the app's `server/content.ts` and the Workspace Store it writes to.
 *
 * The request must carry the Content dev header, must not come from another origin, and must use JSON. `content` is
 * the `content` export of the app's Content Definition, or `undefined` when the app has none.
 */
export async function handleContentDevRequest(request: Request, content: unknown): Promise<Response> {
  const { rejection } = await validateViteHubNitroDevRequest(request, { header: contentDevHeader, headerValue: contentDevHeaderValue, label: "Content Dev" })
  if (rejection) return rejection
  try {
    if (!isContentRuntime(content)) {
      throw new ContentDevRequestError("The Content Definition does not export a defineContent() runtime named `content`.", 409, "CONTENT_UNDEFINED")
    }
    const body: unknown = await request.json().catch(() => undefined)
    return json(await runOperation(content, readBody(body)))
  }
  catch (error) {
    if (error instanceof ContentDevRequestError) return failure(error.message, error.status, error.code, error.details)
    const code = errorCode(error)
    const message = error instanceof Error ? error.message : String(error)
    const status = code === undefined ? undefined : errorStatus.get(code)
    if (status) return failure(message, status, code, Reflect.get(Object(error), "details"))
    return failure(`The Content operation failed: ${message}`, 500, code)
  }
}
