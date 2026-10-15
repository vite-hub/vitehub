import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { buildArtifact, contentHub } from "comark-content"
import json from "comark-content/plugins/json"
import yaml from "comark-content/plugins/yaml"
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
import { isContentCollectionDefinition } from "./documents.ts"
import { contentSitemapEntries, normalizeSeoOptions, renderContentRobots, renderContentSitemap, siteOrigin } from "./sitemap.ts"
import type {
  AnyContentCollection,
  ContentCollection,
  ContentCollectionsRuntime,
  ContentHistorySource,
  ContentPublishOptions,
  ContentPublishResult,
  ContentRevisionsOptions,
  ContentRevisionsResult,
  ContentSingleton,
} from "./collections.ts"
import type { ContentSourceInput } from "./content-source.ts"
import type { ContentCollectionDefinition, SingletonDefinition, DocumentsDefinition } from "./documents.ts"
import type {
  ContentPublishDueOptions,
  ContentPublishDueResult,
  ContentSchedule,
  ContentScheduleOptions,
  ContentSchedulesOptions,
  ContentUnscheduleOptions,
} from "./schedules.ts"
import type { ContentSitemapEntry, ContentSitemapOptions, DefineContentSeoOptions } from "./sitemap.ts"
import type { ContentSessions } from "./sessions.ts"
export { contentSource } from "./content-source.ts"
export { contentScheduleOverdueMs, contentSchedulesRef } from "./schedules.ts"
export type {
  ContentDocumentSchedule,
  ContentPublishDueOptions,
  ContentPublishDueResult,
  ContentSchedule,
  ContentScheduledDocument,
  ContentScheduleFailure,
  ContentScheduleOptions,
  ContentSchedulesOptions,
  ContentScheduleStatus,
  ContentUnscheduleOptions,
} from "./schedules.ts"
export type { ContentSourceInput, ContentSourceOptions, ContentSourceReader } from "./content-source.ts"
export { contentSessionTimeouts } from "./sessions.ts"
export type {
  ContentDocumentSessions,
  ContentSession,
  ContentSessionAcquireOptions,
  ContentSessionOptions,
  ContentSessionReleaseOptions,
  ContentSessionReportOptions,
  ContentSessions,
  ContentSessionUser,
} from "./sessions.ts"
export { documents, optional, singleton } from "./documents.ts"
export { contentSeoLengths, seo } from "./seo.ts"
// Blob owns the reference schemas. Content re-exports them so one import covers every field helper.
export { file, image } from "@vite-hub/blob/reference"
export type { BlobReference, BlobReferenceOptions } from "@vite-hub/blob/reference"
export type { ContentSeo, ContentSeoField, ContentSeoHint, ContentSeoOptions } from "./seo.ts"
export { contentHead, defaultContentImageUrl } from "./head.ts"
export type {
  ContentHead,
  ContentHeadCollection,
  ContentHeadDefaults,
  ContentHeadDocument,
  ContentHeadLink,
  ContentHeadMeta,
  ContentHeadOptions,
  ContentHeadScript,
  ContentHeadSite,
} from "./head.ts"
export { renderContentRobots, renderContentSitemap } from "./sitemap.ts"
export type { ContentSitemapEntry, ContentSitemapOptions, DefineContentSeoOptions } from "./sitemap.ts"
export type {
  ContentCollectionDefinition,
  ContentDocumentUrl,
  ContentEditingOptions,
  ContentField,
  ContentFieldIssue,
  ContentFields,
  ContentFieldsInput,
  ContentFieldsOutput,
  ContentFormat,
  ContentLabel,
  DocumentComponent,
  DocumentComponentProp,
  SingletonDefinition,
  SingletonOptions,
  DocumentsDefinition,
  DocumentsOptions,
} from "./documents.ts"
export type {
  AnyContentCollection,
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
  ContentSingleton,
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

type ContentCollections = Record<string, ContentCollectionDefinition<any>>
type CollectionName<TCollections> = Extract<keyof TCollections, string>
/** The runtime of one `collections` entry: a collection for `documents()`, a singleton for `singleton()`. */
type CollectionOf<TDefinition> =
  TDefinition extends SingletonDefinition<infer TFields> ? ContentSingleton<TFields>
    : TDefinition extends DocumentsDefinition<infer TFields> ? ContentCollection<TFields>
      : AnyContentCollection

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
  /**
   * Editable collections, `documents()`, and singletons, `singleton()`. Each name becomes a Content instance that
   * serves the `published` ref.
   */
  collections?: TCollections
  /** Policy for Content surfaces. Without it, `content.can()` denies every action. */
  authorize?: ContentAuthorize<CollectionName<TCollections>>
  /**
   * Site-wide SEO routes. `sitemap: true` serves `/sitemap.xml` from the published documents of collections with a
   * `url`; `robots: true` serves `/robots.txt`. ViteHub generates the routes when this call sets them.
   */
  seo?: DefineContentSeoOptions
}

/** Document operations added by `collections`. */
export interface ContentDocumentsRuntime<TCollections extends ContentCollections = ContentCollections> {
  /**
   * Every collection and singleton in definition order, with its `name`, `kind`, `format`, `path`, `fields`, and
   * `schema`. Narrow an entry with `kind`. Empty without `collections`.
   */
  collections(): AnyContentCollection[]
  /** Open one collection or singleton to list, read, save, remove, restore, and compare documents. */
  collection<TName extends CollectionName<TCollections>>(name: TName): CollectionOf<TCollections[TName]>
  /** Copy draft documents to the `published` ref in one revision. Pass `expect` to publish exactly what was reviewed. */
  publish(options?: ContentPublishOptions<CollectionName<TCollections>>): Promise<ContentPublishResult>
  /**
   * Publish exactly these reviewed drafts at a later time. The draft digests must match now. At its time,
   * `publishDue()` calls `publish({ expect })`; a draft saved after scheduling makes the schedule `failed` instead.
   */
  schedule(options: ContentScheduleOptions): Promise<ContentSchedule>
  /** Pending, overdue, and failed schedules, earliest first. Schedules that ran are removed; their publish revisions name them. */
  schedules(options?: ContentSchedulesOptions): Promise<ContentSchedule[]>
  /** Cancel a pending schedule, or dismiss a failed one. Throws `CONTENT_NOT_FOUND` when it already ran or is gone. */
  unschedule(id: string, options?: ContentUnscheduleOptions): Promise<void>
  /**
   * Run every pending or overdue schedule whose time has come. Call it from a Schedule Definition, such as one that
   * runs every minute. Runs are safe to overlap: each publish checks the reviewed digests, and each schedule settles once.
   */
  publishDue(options?: ContentPublishDueOptions): Promise<ContentPublishDueResult>
  /** Revisions that saved, removed, restored, or published one document, newest first. */
  revisions(collection: CollectionName<TCollections>, id: string, options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /** Revisions of a singleton defined with `singleton()`. */
  revisions(collection: CollectionName<TCollections>, options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /**
   * Revisions that changed documents of any collection on one ref, newest first: saves, removes, and restores on
   * `draft` (default), publishes on `published`. `metadata.content.documents` names the documents of each.
   */
  revisions(options?: ContentRevisionsOptions): Promise<ContentRevisionsResult>
  /**
   * Presence and edit leases: who has a document open, and which session may edit it. Kept in the Database of the
   * Workspace history, which needs `contentSessionsSchema` from `vite-hub/content/database`.
   */
  readonly sessions: ContentSessions<CollectionName<TCollections>>
  /** Evaluate `defineContent({ authorize })`. Returns false when no policy is defined. */
  can(context: ContentCanContext<CollectionName<TCollections>>): Promise<boolean>
  /**
   * Whether `defineContent({ authorize })` defines a policy. Without one, `can()` denies every action, so surfaces such
   * as the Console show no collections.
   */
  readonly hasPolicy: boolean
  /** `defineContent({ seo })`, or undefined. */
  readonly seo: DefineContentSeoOptions | undefined
  /**
   * The sitemap entries: published documents of collections with a `url`, without `noindex` ones or ones whose
   * canonical URL points elsewhere. `loc` is absolute when `site` is known.
   */
  sitemap(options?: ContentSitemapOptions): Promise<ContentSitemapEntry[]>
  /** The robots.txt text for `defineContent({ seo: { robots } })`. */
  robots(options?: ContentSitemapOptions): string
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
  const { source, sources, workspace, collections, authorize, seo: seoOptions, ...sharedOptions } = options
  const seo = normalizeSeoOptions(seoOptions)
  if (authorize !== undefined && !(authorize instanceof Function)) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] defineContent({ authorize }) must be a function." })
  }
  const collectionEntries = Object.entries(collections ?? {})
  for (const [name, definition] of collectionEntries) {
    if (!isContentCollectionDefinition(definition)) {
      throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content collection ${JSON.stringify(name)} must be defined with documents() or singleton().` })
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
  const documentsRuntime: ContentCollectionsRuntime | undefined = collectionEntries.length
    // SAFETY: Each definition was checked with isContentCollectionDefinition() above.
    ? createContentCollections({ workspace: workspace!, collections: Object.fromEntries(collectionEntries) })
    : undefined
  const collectionInstances: Array<{ instance: ComarkContent, source: ContentHistorySource }> = []
  for (const [name, definition] of collectionEntries) {
    if (Object.hasOwn(inputs, name)) {
      throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content collection ${JSON.stringify(name)} has the same name as a Content source.` })
    }
    const historySource = documentsRuntime!.comarkSource(name)
    // Comark parses Markdown by default. JSON and YAML collections get their parser first, so a configured plugin still wins.
    const format = definition.format === "json" ? json() : definition.format === "yaml" ? yaml() : undefined
    const plugins = format ? [format, ...sharedOptions.plugins ?? []] : sharedOptions.plugins
    const instance = createContentInstance(name, historySource, { ...sharedOptions, plugins, basePath: "/api/content" })
    instances.push(instance)
    collectionInstances.push({ instance, source: historySource })
  }
  const hub = contentHub(instances, { basePath: "/api/content", logger: options.logger })

  // Published collections are refreshed when another writer, process, or host moved the `published` head.
  let syncing: Promise<void> | undefined
  async function syncPublished(): Promise<void> {
    if (!documentsRuntime) return
    syncing ??= (async () => {
      const loaded = collectionInstances.filter(({ instance }) => instance.status !== "created" && instance.status !== "disposed")
      if (!loaded.length) return
      const head = await documentsRuntime.publishedHead()
      const stale: Array<Promise<unknown>> = []
      for (const { instance, source } of loaded) {
        if (source.loadedRevision !== head) stale.push(instance.refresh())
      }
      await Promise.all(stale)
    })().finally(() => {
      syncing = undefined
    })
    await syncing
  }
  documentsRuntime?.onPublish(async (names) => {
    const refreshes: Array<Promise<unknown>> = []
    for (const { instance } of collectionInstances) {
      if (names.includes(instance.name) && instance.status !== "created" && instance.status !== "disposed") refreshes.push(instance.refresh())
    }
    await Promise.all(refreshes)
  })
  function fresh<TArgs extends unknown[], TResult>(method: (...args: TArgs) => Promise<TResult>): (...args: TArgs) => Promise<TResult> {
    return async (...args) => {
      await syncPublished()
      return await method(...args)
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
  const configuredSite = seo?.site === undefined ? undefined : siteOrigin(seo.site)
  const siteFor = (sitemapOptions: ContentSitemapOptions = {}) => sitemapOptions.site === undefined ? configuredSite : siteOrigin(sitemapOptions.site)
  const documentsApi = {
    seo,
    hasPolicy: authorize !== undefined,
    sitemap: async (sitemapOptions?: ContentSitemapOptions) =>
      documentsRuntime ? await contentSitemapEntries([...documentsRuntime.collections.values()], siteFor(sitemapOptions)) : [],
    robots: (sitemapOptions?: ContentSitemapOptions) => {
      const robots = seo?.robots
      return renderContentRobots({
        site: siteFor(sitemapOptions),
        sitemap: seo?.sitemap === true,
        disallow: robots !== null && Object(robots) === robots ? (robots as { disallow?: readonly string[] }).disallow : undefined,
      })
    },
    collections: () => documentsRuntime ? [...documentsRuntime.collections.values()] : [],
    // SAFETY: Each method forwards its arguments unchanged, so the overloads of ContentSessions hold.
    sessions: {
      report: (...args: unknown[]) => Reflect.apply(requireDocuments().sessions.report, undefined, args),
      acquire: (...args: unknown[]) => Reflect.apply(requireDocuments().sessions.acquire, undefined, args),
      release: (...args: unknown[]) => Reflect.apply(requireDocuments().sessions.release, undefined, args),
      list: (collection?: string) => requireDocuments().sessions.list(collection),
    } as ContentSessions,
    collection: (name: string): unknown => requireDocuments().collection(name),
    publish: (publishOptions?: ContentPublishOptions) => requireDocuments().publish(publishOptions),
    schedule: (scheduleOptions: ContentScheduleOptions) => requireDocuments().schedule(scheduleOptions),
    schedules: (schedulesOptions?: ContentSchedulesOptions) => requireDocuments().schedules(schedulesOptions),
    unschedule: (id: string, unscheduleOptions?: ContentUnscheduleOptions) => requireDocuments().unschedule(id, unscheduleOptions),
    publishDue: (dueOptions?: ContentPublishDueOptions) => requireDocuments().publishDue(dueOptions),
    revisions: (collectionOrOptions?: string | ContentRevisionsOptions, id?: string | ContentRevisionsOptions, revisionOptions?: ContentRevisionsOptions) => {
      if (!hasRuntimeType(collectionOrOptions, "string")) return requireDocuments().history(collectionOrOptions)
      // Without a string id, the second argument is the options of a singleton.
      return hasRuntimeType(id, "string") ? requireDocuments().revisions(collectionOrOptions, id, revisionOptions) : requireDocuments().revisions(collectionOrOptions, undefined, id)
    },
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
    get: fresh(hub.get.bind(hub)) as ContentHub["get"],
    navigation: fresh(hub.navigation.bind(hub)),
    handler: fresh(hub.handler.bind(hub)),
    list: fresh((names?: string | string[]) => hub.list(Array.isArray(names) ? names : names ? [names] : undefined)),
    search: fresh((names: string[], query: string, opts?: Parameters<ContentHub["search"]>[1]) => hub.search(query, { ...opts, instances: names })),
    async dispose() {
      documentsRuntime?.dispose()
      await hub.dispose()
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

/** Adapt a Comark Content Web handler to an H3/Nitro route. */
export function defineContentHandler(
  content: Pick<ComarkContent, "handler">,
): ContentHandler {
  // SAFETY: ContentHandler preserves the callable and fetch contracts exposed by H3's handler.
  return defineEventHandler(async (event: H3Event) => await serveContent(content, event)) as ContentHandler
}

type SeoRuntime = Pick<ContentDocumentsRuntime, "robots" | "seo" | "sitemap">

/**
 * Serve `/sitemap.xml` from `content.sitemap()`. URLs use `defineContent({ seo: { site } })`, or the request origin.
 * ViteHub generates this route when `defineContent({ seo: { sitemap: true } })`; mount it yourself in another server.
 */
export function defineContentSitemapHandler(content: SeoRuntime): ContentHandler {
  // SAFETY: ContentHandler preserves the callable and fetch contracts exposed by H3's handler.
  return defineEventHandler(async (event: H3Event) => {
    if (content.seo?.sitemap !== true) return new Response("Not Found", { status: 404 })
    const site = content.seo.site ?? requestUrl(event).origin
    return new Response(renderContentSitemap(await content.sitemap({ site })), {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
    })
  }) as ContentHandler
}

/**
 * Serve `/robots.txt` from `content.robots()`. It names `/sitemap.xml` when the sitemap is on. ViteHub generates this
 * route when `defineContent({ seo: { robots: true } })`.
 */
export function defineContentRobotsHandler(content: SeoRuntime): ContentHandler {
  // SAFETY: ContentHandler preserves the callable and fetch contracts exposed by H3's handler.
  return defineEventHandler(async (event: H3Event) => {
    const robots = content.seo?.robots
    if (robots === undefined || robots === false) return new Response("Not Found", { status: 404 })
    return new Response(content.robots({ site: content.seo?.site ?? requestUrl(event).origin }), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  }) as ContentHandler
}

function nodeHeaders(nodeRequest: NodeContentRequest): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry)
    }
    else headers.set(name, value)
  }
  return headers
}

function nodeUrl(nodeRequest: NodeContentRequest, headers: Headers): URL {
  const protocol = headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() || "http"
  const host = headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim()
    || headers.get("host")
    || "localhost"
  return new URL(nodeRequest.url || "/", `${protocol}://${host}`)
}

/** The request URL of an H3 v2 Web event, or of an H3 v1 (Nitro 2) Node event. */
function requestUrl(event: H3Event): URL {
  if (event.req instanceof Request) return new URL(event.req.url)
  if (!event.node) throw contentErrorDiagnostics.CONTENT_R0005({ message: "[vitehub] Content received an unsupported non-Web request." })
  // SAFETY: H3 exposes a Node IncomingMessage or HTTP/2 request through event.node.req.
  const nodeRequest = event.node.req as NodeContentRequest
  return nodeUrl(nodeRequest, nodeHeaders(nodeRequest))
}

async function serveContent(content: Pick<ComarkContent, "handler">, event: H3Event): Promise<Response> {
  if (event.req instanceof Request) return await content.handler(event.req)

  if (!event.node) throw contentErrorDiagnostics.CONTENT_R0005({ message: "[vitehub] Content received an unsupported non-Web request." })
  // SAFETY: H3 exposes a Node IncomingMessage or HTTP/2 request through event.node.req.
  const nodeRequest = event.node.req as NodeContentRequest
  const method = event.method || nodeRequest.method || "GET"
  const headers = nodeHeaders(nodeRequest)
  const url = nodeUrl(nodeRequest, headers)
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
