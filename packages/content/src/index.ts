import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { buildArtifact, contentHub } from "comark-content"
import { defineEventHandler } from "h3"

import type {
  Cache,
  CacheArtifactOptions,
  ContentHub,
  ContentFile,
  ComarkContent,
  ContentOptions,
  ContentPlugin,
  Source as ComarkContentSource,
} from "comark-content"
import type { H3Event } from "h3"
import { createContentCollections } from "./collections.ts"
import { createContentInstance } from "./content-source.ts"
import { isDocumentsDefinition } from "./documents.ts"
import { createContentPreview } from "./preview.ts"
import type {
  ContentCollection,
  ContentCollectionsRuntime,
  ContentHistorySource,
  ContentPublishOptions,
  ContentPublishResult,
  ContentRef,
  ContentRevisionsOptions,
  ContentRevisionsResult,
} from "./collections.ts"
import type { ContentSourceInput } from "./content-source.ts"
import type { ContentFields, DocumentsDefinition } from "./documents.ts"
import type { ContentPreview } from "./preview.ts"
export { contentSource } from "./content-source.ts"
export { contentKeyVariable, contentPreviewCookieName, defineContentPreviewPlugin } from "./preview.ts"
export type { ContentPreview, ContentPreviewCookie, ContentPreviewEvent, ContentPreviewHost, ContentPreviewOptions } from "./preview.ts"
export type { ContentSourceInput, ContentSourceOptions, ContentSourceReader } from "./content-source.ts"
export { documents, optional } from "./documents.ts"
export type {
  ContentField,
  ContentFieldIssue,
  ContentFields,
  ContentFieldsInput,
  ContentFieldsOutput,
  DocumentsDefinition,
  DocumentsOptions,
} from "./documents.ts"
export type {
  ContentCollection,
  ContentDocument,
  ContentDocumentState,
  ContentDocumentStatus,
  ContentDocumentSummary,
  ContentListOptions,
  ContentPage,
  ContentPublishedDocument,
  ContentPublishExpectation,
  ContentPublishMismatch,
  ContentPublishOptions,
  ContentPublishResult,
  ContentRawDocument,
  ContentReadOptions,
  ContentRef,
  ContentRevisionsOptions,
  ContentRevisionsResult,
  ContentSaveInput,
  ContentWriteOptions,
} from "./collections.ts"

export interface ContentHandler {
  (event: unknown): Promise<unknown>
  fetch(input: Request | URL | string): Promise<Response>
}

export interface ContentHandlerEvent {
  method?: string
  node?: { req: NodeContentRequest }
  req: Request | NodeContentRequest
}

type NodeContentRequest = {
  aborted: boolean
  headers: Record<string, string | string[] | undefined>
  method?: string
  url?: string
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>
  once(event: "aborted", listener: () => void): unknown
}

function nodeBodyChunk(value: unknown): Uint8Array | undefined {
  try {
    if (ArrayBuffer.isView(value)) {
      // SAFETY: ArrayBuffer.isView narrows value to an ArrayBufferView with the required buffer offsets.
      const view = value as ArrayBufferView
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    }
    // Calling the intrinsic getter performs the ArrayBuffer brand check and
    // works for genuine buffers created in another realm.
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value)
    // SAFETY: The intrinsic byteLength getter above verified the ArrayBuffer internal slot.
    return new Uint8Array(value as ArrayBuffer)
  }
  catch {
    return undefined
  }
}

type PluginMethods<TPlugin> = TPlugin extends ContentPlugin<infer TMethods, any> ? TMethods : unknown
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer TIntersection) => void
  ? TIntersection
  : never
type ContentMethods<TPlugins extends ReadonlyArray<ContentPlugin<any, any>>> =
  TPlugins["length"] extends 0 ? unknown : UnionToIntersection<PluginMethods<TPlugins[number]>>

/** What a Content surface asks permission for: reading drafts, saving or removing documents, or publishing. */
export type ContentAction = "read" | "write" | "publish"

/** The signed-in Auth user a surface passes to `authorize`, such as the Auth session user. */
export type ContentUser = Record<string, unknown>

/** The Actor of an Agent Invocation. It has the shape of an Agent Actor, so Content does not depend on the Agent package. */
export interface ContentActor {
  id: string
  kind?: "anonymous" | "chat" | (string & {})
  label?: string
  meta?: Record<string, unknown>
}

export interface ContentAuthorizeContext<TCollection extends string = string> {
  /** The signed-in Auth user, or null. An Agent passes the Auth user its Actor stands for, when there is one. */
  user: ContentUser | null
  /** The invoking Actor when an Agent makes the call, otherwise undefined. */
  actor?: ContentActor
  collection: TCollection
  action: ContentAction
  /** The document, when the action targets one. */
  id?: string
}

/** What `content.can()` takes. `user` defaults to null, so an Agent without an Auth user passes only `actor`. */
export type ContentCanContext<TCollection extends string = string> =
  Omit<ContentAuthorizeContext<TCollection>, "user"> & { user?: ContentUser | null | undefined }

/**
 * Decide whether a user or an Agent Actor may take a Content action. Surfaces such as the Console editor and the
 * Content Agent Capability call it through `content.can()`. The runtime methods themselves are trusted server API and do not.
 */
export type ContentAuthorize<TCollection extends string = string> =
  (context: ContentAuthorizeContext<TCollection>) => boolean | Promise<boolean>

type ContentCollections = Record<string, DocumentsDefinition<any>>
type CollectionName<TCollections> = Extract<keyof TCollections, string>
type FieldsOf<TDefinition> = TDefinition extends DocumentsDefinition<infer TFields> ? TFields : ContentFields

export type DefineContentOptions<
  TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = ReadonlyArray<ContentPlugin<any, any>>,
  TCollections extends ContentCollections = ContentCollections,
> = Omit<ContentOptions, "basePath" | "plugins" | "source" | "sources"> & {
  plugins?: TPlugins
  /** One read-only Source, served as the `default` instance. */
  source?: ContentSourceInput
  /** Named read-only Sources. Each name becomes a Content instance. */
  sources?: Record<string, ContentSourceInput>
  /** Workspace that stores `collections`. It needs retained history, such as the Blob + Database Store. */
  workspace?: string
  /** Editable document collections. Each name becomes a Content instance that serves the `published` ref. */
  collections?: TCollections
  /** Policy for Content surfaces. Without it, `content.can()` denies every action. */
  authorize?: ContentAuthorize<CollectionName<TCollections>>
}

/** Document operations added by `collections`. */
export interface ContentDocumentsRuntime<TCollections extends ContentCollections = ContentCollections> {
  /** Every document collection in definition order, with its `name`, `path`, `fields`, and `schema`. Empty without `collections`. */
  collections(): ContentCollection[]
  /** Open one collection to list, read, save, remove, restore, and compare documents. */
  collection<TName extends CollectionName<TCollections>>(name: TName): ContentCollection<FieldsOf<TCollections[TName]>>
  /** Copy draft documents to the `published` ref in one revision. Pass `expect` to publish exactly what was reviewed. */
  publish(options?: ContentPublishOptions<CollectionName<TCollections>>): Promise<ContentPublishResult>
  /** Revisions that saved, removed, restored, or published one document, newest first. */
  revisions(collection: CollectionName<TCollections>, id: string, options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /** Evaluate `defineContent({ authorize })`. Returns false when no policy is defined. */
  can(context: ContentCanContext<CollectionName<TCollections>>): Promise<boolean>
  /** Draft preview: a signed cookie that makes every Content read in its requests use the `draft` ref. */
  readonly preview: ContentPreview
}

/** Named-source operations retained across the Comark instance API migration. */
export type ContentRuntime = Omit<ContentHub<ComarkContent[]>, "list" | "search" | "media"> & {
  list(names?: string | string[]): ReturnType<ContentHub["list"]>
  search(names: string[], query: string, options?: Parameters<ContentHub["search"]>[1]): ReturnType<ContentHub["search"]>
  getSource(name?: string): ComarkContentSource | undefined
  cache: Omit<Cache, "keys" | "clear"> & {
    clear(name?: string): Promise<void>
    keys(name?: string): Promise<string[]>
    refresh(name: string): ReturnType<ComarkContent["refresh"]>
    snapshot(name: string, options?: CacheArtifactOptions): ReturnType<typeof buildArtifact>
  }
}

const contentActions: ReadonlySet<string> = new Set<ContentAction>(["read", "write", "publish"])

/** Define the Comark Content runtime served by ViteHub from `server/content.ts`. */
export function defineContent<
  const TPlugins extends ReadonlyArray<ContentPlugin<any, any>> = [],
  const TCollections extends ContentCollections = {},
>(options: DefineContentOptions<TPlugins, TCollections> = {}): ContentRuntime & Omit<ContentMethods<TPlugins>, "search"> & ContentDocumentsRuntime<TCollections> {
  if (options.source && options.sources) throw new Error("Define either source or sources, not both.")
  const { source, sources, workspace, collections, authorize, ...sharedOptions } = options
  if (authorize !== undefined && !(authorize instanceof Function)) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] defineContent({ authorize }) must be a function." })
  }
  const collectionEntries = Object.entries(collections ?? {})
  for (const [name, definition] of collectionEntries) {
    if (!isDocumentsDefinition(definition)) {
      throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content collection ${JSON.stringify(name)} must be defined with documents().` })
    }
  }
  if (collectionEntries.length && (String(workspace) !== workspace || !workspace)) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] defineContent({ collections }) requires workspace: the name of a Workspace with retained history." })
  }
  const inputs: Record<string, ContentSourceInput | undefined> = sources ?? (source || !collectionEntries.length ? { default: source } : {})
  const instances = Object.entries(inputs).map(([name, input]) => {
    if (!input) throw new Error(`Content source ${JSON.stringify(name)} is missing.`)
    return createContentInstance(name, input, { ...sharedOptions, basePath: "/api/content" })
  })
  const preview = createContentPreview({ enabled: collectionEntries.length > 0 })
  const documentsRuntime: ContentCollectionsRuntime | undefined = collectionEntries.length
    ? createContentCollections({
        workspace: workspace!,
        // SAFETY: Each definition was checked with isDocumentsDefinition() above.
        collections: Object.fromEntries(collectionEntries),
        defaultRef: () => preview.active() ? "draft" : "published",
      })
    : undefined
  const collectionInstances: Array<{ instance: ComarkContent, source: ContentHistorySource }> = []
  for (const [name] of collectionEntries) {
    if (Object.hasOwn(inputs, name)) {
      throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content collection ${JSON.stringify(name)} has the same name as a Content source.` })
    }
    const historySource = documentsRuntime!.comarkSource(name)
    const instance = createContentInstance(name, historySource, { ...sharedOptions, basePath: "/api/content" })
    instances.push(instance)
    collectionInstances.push({ instance, source: historySource })
  }
  const hub = contentHub(instances, { basePath: "/api/content", logger: options.logger })

  // A preview request reads a second hub whose collection instances are pinned to `draft` with their own cache namespace.
  let draft: { hub: ContentHub<ComarkContent[]>, instances: Array<{ instance: ComarkContent, source: ContentHistorySource }> } | undefined
  function draftHub() {
    if (!draft) {
      const pinned = hub.withRefs(Object.fromEntries(collectionEntries.map(([name]) => [name, "draft"])))
      const names = new Set(collectionEntries.map(([name]) => name))
      draft = {
        hub: pinned,
        // SAFETY: Collection instances read a ContentHistorySource, and withRef() pins it through comarkSource().
        instances: pinned.instances.filter(instance => names.has(instance.name)).map(instance => ({ instance, source: instance.getSource(instance.name) as ContentHistorySource })),
      }
    }
    return draft
  }

  // Loaded collection instances are refreshed when another writer, process, or host moved the head of their ref.
  const syncing = new Map<ContentRef, Promise<void>>()
  async function sync(ref: ContentRef): Promise<void> {
    if (!documentsRuntime) return
    let pending = syncing.get(ref)
    if (!pending) {
      pending = (async () => {
        const loaded = (ref === "draft" ? draftHub().instances : collectionInstances)
          .filter(({ instance }) => instance.status !== "created" && instance.status !== "disposed")
        if (!loaded.length) return
        const head = await documentsRuntime.head(ref)
        const stale: Array<Promise<unknown>> = []
        for (const { instance, source } of loaded) {
          if (source.loadedRevision !== head) stale.push(instance.refresh())
        }
        await Promise.all(stale)
      })().finally(() => {
        syncing.delete(ref)
      })
      syncing.set(ref, pending)
    }
    await pending
  }
  documentsRuntime?.onPublish(async (names) => {
    const refreshes: Array<Promise<unknown>> = []
    for (const { instance } of collectionInstances) {
      if (names.includes(instance.name) && instance.status !== "created" && instance.status !== "disposed") refreshes.push(instance.refresh())
    }
    await Promise.all(refreshes)
  })
  /** Run a read on the hub of the current request's ref after refreshing stale instances. */
  function fresh<TArgs extends unknown[], TResult>(method: (target: ContentHub<ComarkContent[]>, ...args: TArgs) => Promise<TResult>): (...args: TArgs) => Promise<TResult> {
    return async (...args) => {
      if (documentsRuntime && preview.active()) {
        await sync("draft")
        return await method(draftHub().hub, ...args)
      }
      await sync("published")
      return await method(hub, ...args)
    }
  }
  function requireDocuments(): ContentCollectionsRuntime {
    if (!documentsRuntime) {
      throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] This Content runtime has no collections. Add defineContent({ workspace, collections })." })
    }
    return documentsRuntime
  }
  const byName = new Map(instances.map(instance => [instance.name, instance]))
  function from(name: string) {
    const instance = byName.get(name)
    if (!instance) throw new Error(`Unknown content source ${JSON.stringify(name)}.`)
    return instance
  }
  function cacheForKey(key: string) {
    const instance = instances.find(candidate => key.startsWith(`${candidate.name}:`))
    if (!instance) throw new Error(`Unknown content cache key ${JSON.stringify(key)}.`)
    return instance.cache
  }
  // SAFETY: collection() returns the runtime built from TCollections[TName], whose fields type its documents.
  const documentsApi = {
    preview,
    collections: () => documentsRuntime ? [...documentsRuntime.collections.values()] : [],
    collection: (name: string) => requireDocuments().collection(name),
    publish: (publishOptions?: ContentPublishOptions) => requireDocuments().publish(publishOptions),
    revisions: (collection: string, id: string, revisionOptions?: ContentRevisionsOptions) => requireDocuments().revisions(collection, id, revisionOptions),
    async can(context: ContentCanContext<CollectionName<TCollections>>): Promise<boolean> {
      if (context === null || Object(context) !== context || !contentActions.has(context.action)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.can() requires { user?, actor?, collection, action: 'read' | 'write' | 'publish', id? }." })
      }
      const { user = null, actor, collection, action, id } = context
      if (user !== null && Object(user) !== user) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.can() user must be the Auth user object or null." })
      }
      if (actor !== undefined && (actor === null || Object(actor) !== actor || String(actor.id) !== actor.id)) {
        throw contentErrorDiagnostics.CONTENT_R0008({ message: "[vitehub] content.can() actor must be an Agent Actor with an id, or undefined." })
      }
      requireDocuments().collection(collection)
      if (!authorize) return false
      const decision: ContentAuthorizeContext<CollectionName<TCollections>> = { user, collection, action }
      if (actor !== undefined) decision.actor = actor
      if (id !== undefined) decision.id = id
      return await authorize(decision) === true
    },
  } as ContentDocumentsRuntime<TCollections>
  const runtime: ContentRuntime & ContentDocumentsRuntime<TCollections> = {
    ...hub,
    ...documentsApi,
    // SAFETY: The wrapper forwards the path and options without changing the generic document result.
    get: fresh((target, key: string, opts?: Parameters<ContentHub["get"]>[1]) => target.get(key, opts)) as ContentHub["get"],
    navigation: fresh((target, names?: Parameters<ContentHub["navigation"]>[0]) => target.navigation(names)),
    handler: fresh((target, request: Request) => target.handler(request)),
    list: fresh((target, names?: string | string[]) => target.list(Array.isArray(names) ? names : names ? [names] : undefined)),
    search: fresh((target, names: string[], query: string, opts?: Parameters<ContentHub["search"]>[1]) => target.search(query, { ...opts, instances: names })),
    async dispose() {
      documentsRuntime?.dispose()
      // The draft hub shares every non-collection instance with `hub`, so dispose only its pinned collections.
      await Promise.all([hub.dispose(), ...(draft?.instances ?? []).map(({ instance }) => instance.dispose())])
    },
    getSource: (name = "default") => byName.get(name)?.getSource(name),
    cache: {
      get: <T = ContentFile>(key: string) => cacheForKey(key).get<T>(key),
      set: <T = ContentFile>(key: string, value: T) => cacheForKey(key).set(key, value),
      invalidate: (key: string) => cacheForKey(key).invalidate(key),
      expire: (key: string) => cacheForKey(key).expire(key),
      async clear(name?: string) {
        await Promise.all((name ? [from(name)] : instances).map(instance => instance.cache.clear()))
      },
      async keys(name?: string) {
        const selected = name ? [from(name)] : instances
        return (await Promise.all(selected.map(instance => instance.cache.keys()))).flat()
      },
      refresh: (name: string) => from(name).refresh(),
      async snapshot(name: string, opts?: CacheArtifactOptions) {
        const instance = from(name)
        const items = await instance.refresh()
        return buildArtifact(name, JSON.stringify({ items, time: Date.now() }), opts)
      },
    },
  }
  // Preserve custom plugin methods; Comark's hub owns cross-source search, query and media.
  for (const instance of instances) {
    for (const [key, value] of Object.entries(instance)) {
      if (!Object.hasOwn(runtime, key)) Object.defineProperty(runtime, key, { enumerable: true, value })
    }
  }
  // SAFETY: The instances install the declared plugin methods and the hub composes built-in methods.
  return runtime as ContentRuntime & Omit<ContentMethods<TPlugins>, "search"> & ContentDocumentsRuntime<TCollections>
}

/**
 * Adapt a Comark Content Web handler to an H3/Nitro route. With a Content runtime, a request with a valid preview
 * cookie reads the `draft` ref and gets `Cache-Control: private, no-store`.
 */
export function defineContentHandler(
  content: Pick<ComarkContent, "handler"> & { preview?: ContentPreview },
): ContentHandler {
  // SAFETY: ContentHandler preserves the callable and fetch contracts exposed by H3's handler.
  return defineEventHandler(async (event: H3Event) => {
    if (!content.preview) return await serveContent(content, event)
    return await content.preview.run(event, () => serveContent(content, event))
  }) as ContentHandler
}

async function serveContent(content: Pick<ComarkContent, "handler">, event: H3Event): Promise<Response> {
  if (event.req instanceof Request) return await content.handler(event.req)

  if (!event.node) throw contentErrorDiagnostics.CONTENT_R0005({ message: "[vitehub] Content received an unsupported non-Web request." })
  // SAFETY: H3 exposes a Node IncomingMessage or HTTP/2 request through event.node.req.
  const nodeRequest = event.node.req as NodeContentRequest
  const method = event.method || nodeRequest.method || "GET"
  const headers = new Headers()
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry)
    }
    else headers.set(name, value)
  }
  const protocol = headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() || "http"
  const host = headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim()
    || headers.get("host")
    || "localhost"
  const url = new URL(nodeRequest.url || "/", `${protocol}://${host}`)
  let body: Uint8Array | undefined
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Uint8Array[] = []
    for await (const chunk of nodeRequest) {
      const bytes = nodeBodyChunk(chunk)
      if (!bytes) throw contentErrorDiagnostics.CONTENT_R0005({ message: "[vitehub] Content received an invalid request body chunk." })
      chunks.push(bytes)
    }
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    body = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
  }
  const abort = new AbortController()
  if (nodeRequest.aborted) abort.abort()
  else nodeRequest.once("aborted", () => abort.abort())

  return await content.handler(new Request(url, {
    body,
    headers,
    method,
    signal: abort.signal,
  }))
}
