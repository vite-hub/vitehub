import { createViteHubConsoleActionError } from "@vite-hub/internal/console"

import type {
  ViteHubConsoleActionFailure,
  ViteHubConsoleDocument,
  ViteHubConsoleDocumentActionContext,
  ViteHubConsoleDocumentActions,
  ViteHubConsoleDocumentActionsFactory,
  ViteHubConsoleDocumentChange,
  ViteHubConsoleDocumentCollection,
  ViteHubConsoleDocumentListInput,
  ViteHubConsoleDocumentPage,
  ViteHubConsoleDocumentPublishExpectation,
  ViteHubConsoleDocumentRevision,
  ViteHubConsoleDocumentState,
} from "@vite-hub/internal/console"
import type { ContentAction, ContentDocumentsRuntime } from "../index.ts"
import type { ContentCollection, ContentDocument, ContentListOptions } from "../collections.ts"

type ContentRuntime = Pick<ContentDocumentsRuntime, "can" | "collection" | "collections" | "publish" | "revisions">

const documentStates: readonly ViteHubConsoleDocumentState[] = ["draft", "published", "changed", "deleted"]
const titleFields = ["title", "name", "label", "heading"]
const maximumListLimit = 200

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
    throw failure(422, "CONTENT_INVALID", id ? `${id} has invalid fields.` : "Some fields are invalid.", id ? { id, issues: json(details.issues ?? []) } : { issues: json(details.issues ?? []) })
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

function titleFieldOf(schema: Record<string, unknown>): string | undefined {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const isString = (field: string) => isRecord(properties[field]) && properties[field].type === "string"
  const required = Array.isArray(schema.required) ? schema.required.filter(field => String(field) === field) : []
  return titleFields.find(isString) ?? required.find(isString)
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

function revisionAuthor(metadata: Record<string, unknown> | undefined): string | undefined {
  const by = metadata?.author
  if (!isRecord(by)) return
  for (const key of ["name", "email", "id"]) {
    const value = by[key]
    if (String(value) === value && value) return value
  }
}

function revisionAction(metadata: Record<string, unknown> | undefined): string {
  const content = metadata?.content
  const action = isRecord(content) ? content.action : undefined
  return String(action) === action ? action : "change"
}

/**
 * Create the Console document actions for the `content` export of `server/content.ts`. Every action checks
 * `content.can()` with the signed-in Console user before it calls the trusted runtime method.
 */
export const createContentConsoleActions: ViteHubConsoleDocumentActionsFactory = (module) => {
  const content = contentRuntime(module.content)

  function open(name: unknown): ContentCollection {
    const collectionName = text(name, "collection")
    if (!content.collections().some(collection => collection.name === collectionName)) {
      throw failure(404, "CONTENT_COLLECTION_NOT_FOUND", `Content has no collection named ${JSON.stringify(collectionName)}.`)
    }
    return content.collection(collectionName)
  }

  async function allow(context: ViteHubConsoleDocumentActionContext, collection: ContentCollection, action: ContentAction, id?: string): Promise<void> {
    const allowed = await content.can(id === undefined
      ? { user: context.user, collection: collection.name, action }
      : { user: context.user, collection: collection.name, action, id })
    if (!allowed) {
      throw failure(403, "CONTENT_FORBIDDEN", `You cannot ${action === "read" ? "read drafts of" : action === "write" ? "edit" : "publish"} this ${id === undefined ? "collection" : "document"}.`)
    }
  }

  async function stateOf(collection: ContentCollection, id: string): Promise<ViteHubConsoleDocumentState | undefined> {
    return (await collection.status(id))?.state
  }

  async function view(collection: ContentCollection, document: ContentDocument, state?: ViteHubConsoleDocumentState): Promise<ViteHubConsoleDocument> {
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
    const current = state ?? await stateOf(collection, document.id)
    if (current) result.state = current
    return result
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
          label: label(collection.name),
          path: collection.path,
          schema,
          access: { read: Boolean(read), write: Boolean(write), publish: Boolean(publish) },
        }
        const titleField = titleFieldOf(schema)
        if (titleField) entry.titleField = titleField
        collections.push(entry)
      }
      return collections
    },

    async list(input: ViteHubConsoleDocumentListInput, context): Promise<ViteHubConsoleDocumentPage> {
      if (!isRecord(input)) throw invalidInput("list() requires { collection }.")
      const collection = open(input.collection)
      await allow(context, collection, "read")
      if (input.state !== undefined && !documentStates.includes(input.state)) throw invalidInput("state must be draft, published, changed, or deleted.")
      const limit = input.limit ?? 50
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumListLimit) throw invalidInput(`limit must be an integer from 1 to ${maximumListLimit}.`)
      return await attempt(async () => {
        const statuses = await collection.status()
        const authorizedStatuses = (await Promise.all(statuses.map(async (status) =>
          await content.can({ user: context.user, collection: collection.name, action: "read", id: status.id }) ? status : null,
        ))).filter((status): status is (typeof statuses)[number] => status !== null)
        const states: Record<ViteHubConsoleDocumentState, number> = { draft: 0, published: 0, changed: 0, deleted: 0 }
        const statusById = new Map(authorizedStatuses.map(status => [status.id, status]))
        const changes: ViteHubConsoleDocumentChange[] = []
        for (const status of authorizedStatuses) {
          states[status.state]++
          if (status.state !== "published") changes.push({ id: status.id, state: status.state, digest: status.draft })
        }
        const filter: NonNullable<ContentListOptions["filter"]> = {}
        for (const [field, value] of Object.entries(isRecord(input.filter) ? input.filter : {})) {
          const values = Array.isArray(value) ? value : [value]
          if (!values.every(entry => String(entry) === entry)) throw invalidInput("filter values must be strings.")
          if (values.length) Object.assign(filter, { [field]: values })
        }
        // Deleted documents exist only on `published`, so that state lists them from there.
        let ref: "draft" | "published" = "draft"
        const authorizedIds = authorizedStatuses.map(status => status.id)
        if (!authorizedIds.length) return { items: [], nextCursor: null, total: 0, states, changes }
        Object.assign(filter, { id: input.state
          ? authorizedStatuses.filter(status => status.state === input.state).map(status => status.id)
          : authorizedIds })
        if (input.state && !(filter.id as string[]).length) return { items: [], nextCursor: null, total: 0, states, changes }
        if (input.state === "deleted") ref = "published"
        const options: ContentListOptions = { ref, filter, limit }
        const searchValue = optionalText(input.search, "search")
        const search = searchValue?.trim() || undefined
        if (search) options.search = search
        if (input.cursor !== undefined) options.cursor = text(input.cursor, "cursor")
        if (input.sort) options.sort = { field: text(input.sort.field, "sort.field"), direction: input.sort.direction === "desc" ? "desc" : "asc" }
        if (input.facets?.length) options.facets = input.facets.map(field => text(field, "facets"))
        const page = await collection.list(options)
        const titleField = titleFieldOf(collection.schema)
        const result: ViteHubConsoleDocumentPage = {
          items: page.items.map((item) => {
            const title = titleField ? item.data[titleField] : undefined
            const status = statusById.get(item.id)
            return {
              id: item.id,
              path: item.path,
              title: String(title) === title && title.trim() ? title : item.id,
              state: status?.state ?? (ref === "published" ? "deleted" : "draft"),
              data: json(item.data),
              // A deleted document is listed from `published`, but publishing it expects no draft.
              digest: status ? status.draft : ref === "draft" ? item.digest : null,
              updatedAt: item.updatedAt,
            }
          }),
          nextCursor: page.nextCursor,
          total: page.total,
          states,
          changes,
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
      return await attempt(async () => await view(collection, await collection.save(id, { data, body: input.body }, { ifDigest, metadata: writeMetadata(context) })))
    },

    async remove(input, context) {
      if (!isRecord(input)) throw invalidInput("remove() requires { collection, id, ifDigest }.")
      const collection = open(input.collection)
      const id = text(input.id, "id")
      await allow(context, collection, "write", id)
      const ifDigest = text(input.ifDigest, "ifDigest")
      await attempt(async () => await collection.remove(id, { ifDigest, metadata: writeMetadata(context) }))
    },

    async publish(input, context) {
      if (!isRecord(input) || !Array.isArray(input.expect) || !input.expect.length) {
        throw invalidInput("publish() requires { collection, expect: [{ id, digest }] } with the draft digests that were reviewed.")
      }
      const collection = open(input.collection)
      const expected: ViteHubConsoleDocumentPublishExpectation[] = input.expect.map((entry: unknown) => {
        if (!isRecord(entry)) throw invalidInput("Each expect entry must be { id, digest }.")
        return { id: text(entry.id, "expect.id"), digest: digest(entry.digest, "expect.digest") }
      })
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
      return await attempt(async () => await view(collection, await collection.restore(id, revision, { ifDigest, metadata: writeMetadata(context) })))
    },
  }
  return actions
}
