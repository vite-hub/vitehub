import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText } from "@vite-hub/internal/inspect"

import { contentDevHeader, contentDevHeaderValue, isContentDevOperation } from "../dev.ts"

import type {
  ContentCollection,
  ContentDocumentState,
  ContentPublishExpectation,
  ContentPublishOptions,
  ContentPublishResult,
  ContentRawDocument,
  ContentRevisionsOptions,
  ContentRevisionsResult,
} from "../collections.ts"
import type {
  ContentDevCollection,
  ContentDevCollectionsResult,
  ContentDevDiffResult,
  ContentDevDiffSide,
  ContentDevPublishResult,
  ContentDevRequestBody,
  ContentDevRevisionsResult,
  ContentDevStatusResult,
} from "../dev.ts"

/** The parts of a `defineContent()` runtime that the dev endpoint uses. */
interface ContentDevRuntime {
  collections(): ContentCollection[]
  collection(name: string): ContentCollection
  publish(options?: ContentPublishOptions): Promise<ContentPublishResult>
  revisions(collection: string, id: string, options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
}

class ContentDevRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

const errorStatus = new Map([
  ["CONTENT_INVALID", 422],
  ["CONTENT_NOT_FOUND", 404],
  ["CONTENT_R0007", 409],
  ["CONTENT_R0008", 400],
  ["CONTENT_R0009", 400],
  ["WORKSPACE_CONFLICT", 409],
])

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
    && Reflect.get(Object(value), "collections") instanceof Function
    && Reflect.get(Object(value), "collection") instanceof Function
    && Reflect.get(Object(value), "publish") instanceof Function
    && Reflect.get(Object(value), "revisions") instanceof Function
}

function readString(body: Record<string, unknown>, name: string): string | undefined {
  const value: unknown = body[name]
  if (value === undefined) return
  if (String(value) !== value || !value) throw new ContentDevRequestError(`${name} must be a nonempty string.`, 400)
  return value
}

function readBody(value: unknown): ContentDevRequestBody {
  if (value === null || Object(value) !== value || Array.isArray(value)) throw new ContentDevRequestError("The Content Dev request body is invalid.", 400)
  // SAFETY: The guard above admits only non-array objects.
  const body = value as Record<string, unknown>
  if (!isContentDevOperation(body.operation)) throw new ContentDevRequestError("The Content Dev request body is invalid.", 400)
  const parsed: ContentDevRequestBody = { operation: body.operation }
  for (const name of ["collection", "id", "cursor", "message"] as const) {
    const string = readString(body, name)
    if (string !== undefined) parsed[name] = string
  }
  if (body.ref !== undefined) {
    if (body.ref !== "draft" && body.ref !== "published") throw new ContentDevRequestError("ref must be \"draft\" or \"published\".", 400)
    parsed.ref = body.ref
  }
  if (body.limit !== undefined) {
    if (!Number.isSafeInteger(body.limit) || Number(body.limit) < 1) throw new ContentDevRequestError("limit must be a positive integer.", 400)
    parsed.limit = Number(body.limit)
  }
  if (body.ids !== undefined) {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.some(id => String(id) !== id || !id)) {
      throw new ContentDevRequestError("ids must be a non-empty list of document ids.", 400)
    }
    parsed.ids = body.ids.map(String)
  }
  if (body.dryRun !== undefined) {
    if (body.dryRun !== true && body.dryRun !== false) throw new ContentDevRequestError("dryRun must be a boolean.", 400)
    parsed.dryRun = body.dryRun
  }
  if (body.expect !== undefined) parsed.expect = readExpect(body.expect)
  return parsed
}

function readExpect(value: unknown): ContentPublishExpectation[] {
  const invalid = () => new ContentDevRequestError("expect must be a non-empty list of { collection, id, digest }, with digest a string or null.", 400)
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

function requireCollection(body: ContentDevRequestBody): string {
  if (body.collection === undefined) throw new ContentDevRequestError(`The ${body.operation} operation requires a collection.`, 400)
  return body.collection
}

function requireId(body: ContentDevRequestBody): string {
  if (body.id === undefined) throw new ContentDevRequestError(`The ${body.operation} operation requires a document id.`, 400)
  return body.id
}

function notFound(collection: string, id: string): ContentDevRequestError {
  return new ContentDevRequestError(`Content document ${JSON.stringify(`${collection}/${id}`)} exists on neither draft nor published.`, 404, "CONTENT_NOT_FOUND")
}

async function listCollections(content: ContentDevRuntime): Promise<ContentDevCollectionsResult> {
  const collections = await Promise.all(content.collections().map(async (collection): Promise<ContentDevCollection> => {
    const statuses = await collection.status()
    const states: Record<ContentDocumentState, number> = { draft: 0, published: 0, changed: 0, deleted: 0 }
    for (const status of statuses) states[status.state]++
    return { name: collection.name, path: collection.path, fields: [...collection.fields], documents: statuses.length, states }
  }))
  return { collections }
}

function selectedCollections(content: ContentDevRuntime, name: string | undefined): ContentCollection[] {
  return name === undefined ? content.collections() : [content.collection(name)]
}

async function readStatus(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevStatusResult> {
  if (body.id !== undefined) {
    const collection = requireCollection(body)
    const status = await content.collection(collection).status(body.id)
    if (!status) throw notFound(collection, body.id)
    return { documents: [status] }
  }
  const documents = await Promise.all(selectedCollections(content, body.collection).map(collection => collection.status()))
  return { documents: documents.flat() }
}

function diffSide(raw: ContentRawDocument | null): ContentDevDiffSide | null {
  return raw ? { digest: raw.digest, text: raw.text } : null
}

async function readDiff(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevDiffResult> {
  const name = requireCollection(body)
  const id = requireId(body)
  const collection = content.collection(name)
  // raw() returns the stored file even when it no longer validates, so a diff can show what to repair.
  const [status, published, draft] = await Promise.all([
    collection.status(id),
    collection.raw(id, { ref: "published" }),
    collection.raw(id, { ref: "draft" }),
  ])
  const path = draft?.path ?? published?.path
  if (!status || !path) throw notFound(name, id)
  return { collection: name, id, path, state: status.state, published: diffSide(published), draft: diffSide(draft) }
}

async function readRevisions(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<ContentDevRevisionsResult> {
  const collection = requireCollection(body)
  const id = requireId(body)
  const ref = body.ref ?? "draft"
  const options: ContentRevisionsOptions = { ref }
  if (body.limit !== undefined) options.limit = body.limit
  if (body.cursor !== undefined) options.cursor = body.cursor
  const page = await content.revisions(collection, id, options)
  const result: ContentDevRevisionsResult = { collection, id, ref, revisions: page.revisions }
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
    if (body.expect !== undefined) throw new ContentDevRequestError("A publish dry run selects documents with collection and ids, not expect.", 400)
    if (body.ids !== undefined && body.collection === undefined) throw new ContentDevRequestError("Publishing documents by id requires a collection.", 400)
    const documents: ContentDevPublishResult["documents"] = []
    for (const collection of selectedCollections(content, body.collection)) {
      const statuses = body.ids === undefined
        ? await collection.status()
        : await Promise.all(body.ids.map(async (id) => {
            const status = await collection.status(id)
            if (!status) throw notFound(collection.name, id)
            return status
          }))
      for (const status of statuses) {
        if (status.state !== "published") documents.push({ collection: status.collection, id: status.id, change: pendingChange[status.state], digest: status.draft })
      }
    }
    return { dryRun: true, revision: null, documents }
  }
  if (body.expect === undefined) {
    throw new ContentDevRequestError("A publish needs expect: the draft digests from a dry run that the user confirmed.", 400)
  }
  if (body.collection !== undefined || body.ids !== undefined) {
    throw new ContentDevRequestError("A publish names its documents in expect. Do not combine it with collection or ids.", 400)
  }
  const options: ContentPublishOptions = { expect: body.expect }
  if (body.message !== undefined) options.message = body.message
  const result = await content.publish(options)
  return { dryRun: false, revision: result.revision, documents: result.documents }
}

async function runOperation(content: ContentDevRuntime, body: ContentDevRequestBody): Promise<unknown> {
  switch (body.operation) {
    case "collections": return await listCollections(content)
    case "status": return await readStatus(content, body)
    case "diff": return await readDiff(content, body)
    case "revisions": return await readRevisions(content, body)
    case "publish": return await publish(content, body)
  }
}

function errorCode(error: unknown): string | undefined {
  const code: unknown = Reflect.get(Object(error), "code")
  return String(code) === code ? code : undefined
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
    if (error instanceof ContentDevRequestError) return failure(error.message, error.status, error.code)
    const code = errorCode(error)
    const message = error instanceof Error ? error.message : String(error)
    const status = code === undefined ? undefined : errorStatus.get(code)
    if (status) return failure(message, status, code, Reflect.get(Object(error), "details"))
    return failure(`The Content operation failed: ${message}`, 500, code)
  }
}
