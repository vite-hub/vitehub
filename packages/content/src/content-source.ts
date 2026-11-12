import { AsyncLocalStorage } from "node:async_hooks"

import { comarkContent, memory } from "comark-content"
import type { ContentGetOptions, ContentOptions, JsonSchema, ParsedSource, Source as ComarkContentSource } from "comark-content"
import { createSource, useSource } from "@vite-hub/source"
import type { Source, SourceItem, SourceName, SourceRevision } from "@vite-hub/source"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"
import { withContentSnapshot } from "./snapshots.ts"

import type { ContentDocumentUrl } from "./documents.ts"
import type { ContentSnapshotLoader } from "./snapshots.ts"

export interface ContentSourceOptions {
  prefix?: string
  schema?: JsonSchema
  /**
   * The public URL of each document, such as `/:id` or `/docs/:id`. The id is the document path without its leading
   * slash, such as `guides/start`, and `:<name>` reads a frontmatter value. `defineContent({ seo: { sitemap: true } })`
   * lists the documents of a Source with a `url`.
   */
  url?: ContentDocumentUrl
  /** The display name of the Source, such as its `llms.txt` section. Defaults to the Source name in title case. */
  label?: string
  /**
   * The SEO values of a document, for frontmatter that does not use Content's `seo` field: `{ title, description,
   * noindex, canonical }`. Defaults to `data.seo`, then the `title` and `description` fields. A `noindex` page keeps its
   * Markdown copy, but the sitemap, `llms.txt`, and `list-pages` leave it out.
   */
  seo?: (document: { id: string, key?: string, data: Record<string, unknown> }) => ContentSourceSeo | undefined
  /**
   * The Markdown copy of a page for agents, such as `/docs/kv.md`, when the file needs more than its frontmatter removed.
   * `text` is the whole file. Return a string, or `{ markdown, footer }`: the copy at `<url>.md` ends with `footer`, and
   * `llms-full.txt` and the MCP `get-page` tool leave it out, because their readers see every page. Return null for a
   * page without a copy. Defaults to the title as a heading, the description as a quote, then the body.
   */
  markdown?: (page: ContentSourceMarkdownPage) => ContentSourceMarkdown | null | Promise<ContentSourceMarkdown | null>
}

/** The SEO values of a Source document, from `contentSource(input, { seo })`. */
export interface ContentSourceSeo {
  title?: string
  description?: string
  noindex?: boolean
  canonical?: string
}

/** A Source page that `contentSource(input, { markdown })` renders. */
export interface ContentSourceMarkdownPage {
  /** The document path without its leading slash, such as `docs/kv`. */
  id: string
  /** The Source key of the file, such as `docs/kv.md`. */
  key: string
  /** The page path, such as `/docs/kv`. */
  path: string
  /** The whole file, with its frontmatter. */
  text: string
  title?: string
  description?: string
  /** The public origin, such as `https://example.com`, when it is known. */
  site?: string
}

/** A Markdown copy: the text, or the text and a footer that only the copy at `<url>.md` ends with. */
export type ContentSourceMarkdown = string | { markdown: string, footer?: string }

/** The page options of a Source with a `url`. */
export interface ContentSourceRoute {
  url: ContentDocumentUrl
  label?: string
  seo?: ContentSourceOptions["seo"]
  markdown?: ContentSourceOptions["markdown"]
}

type ContentSourceItem = SourceItem<string, unknown, object>
type RuntimeObject = Record<string, unknown>
/** How each load of a Source definition reads one commit, such as the head commit of a `github()` Source. */
export interface ContentSourceCommits {
  /** The commit that the next load reads, or undefined to read the Source as it is. A read outside a load first syncs the head. */
  revision(): Promise<SourceRevision | undefined>
  /** The files of a commit, from the commit cache. */
  files(revision: SourceRevision): Promise<ContentSourceItem[]>
  /** The parsed documents of the commit that the instance serves, as a Comark parsed Source over `origin`. */
  documents(origin: ComarkContentSource): ParsedSource
}
type ContentSourceFactoryOptions = Omit<ContentSourceOptions, keyof ContentSourceRoute> & { commits?: ContentSourceCommits }
type ContentSourceFactory = {
  create(options?: ContentSourceFactoryOptions): ComarkContentSource
}
type ContentSourceState = {
  latestItems?: Map<string, ContentSourceItem>
  latestSequence: number
  nextSequence: number
}
export interface ContentSourceReader {
  items(): Promise<ContentSourceItem[]>
}

export type ContentSourceInput =
  | Source<string, unknown, object>
  | SourceName
  | ContentSourceReader
  | (() => ContentSourceReader)
  | ComarkContentSource

const contentSourceFactory = Symbol("vitehub.contentSourceFactory")
const contentSourceRouteKey = Symbol("vitehub.contentSourceRoute")
/** The `@vite-hub/source` Source definition that each adapter reads. */
const contentSourceDefinitions = new WeakMap<ComarkContentSource, Source<string, unknown, object>>()
const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)!.get!

function normalizeContentSourcePath(path: unknown = ""): string {
  if (typeof path !== "string") {
    throw contentErrorDiagnostics.CONTENT_R0001({ message: "[vitehub] Content Source paths must be strings." })
  }
  const raw = path.replace(/\\/g, "/")
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "")
  const parts = normalized.split("/").filter(Boolean)
  if (
    !normalized
    || raw.startsWith("/")
    || /^[a-z]:\//i.test(raw)
    || parts.some(part => part === "." || part === "..")
    || parts[0] === ".git"
    || parts[0] === ".vitehub"
  ) {
    throw contentErrorDiagnostics.CONTENT_R0001({ message: `[vitehub] Content Source path escapes the source root: ${path}.` })
  }
  return normalized
}

function contentPath(item: ContentSourceItem): string {
  const path = "path" in item && item.path !== undefined ? item.path : item.key
  return normalizeContentSourcePath(path)
}

function textContent(item: ContentSourceItem): string {
  // `instanceof` rejects bytes supplied by a Source running in another realm.
  // The intrinsic tag check keeps the conversion limited to Uint8Array values.
  if (isUint8Array(item.content)) return new TextDecoder().decode(item.content)
  if (item.content !== undefined) return item.content
  if (item.data !== undefined) {
    const serialized = JSON.stringify(item.data)
    if (serialized !== undefined) return serialized
  }
  throw contentErrorDiagnostics.CONTENT_R0002({ message: `[vitehub] contentSource() cannot read ${JSON.stringify(item.key)} as content.` })
}

function isRuntimeFunction(value: unknown): value is Function {
  if (value === null || Object(value) !== value) return false
  try {
    Function.prototype.toString.call(value)
    return true
  } catch {
    return false
  }
}

function isRuntimeObject(value: unknown): value is RuntimeObject {
  return value !== null && Object(value) === value && !isRuntimeFunction(value)
}

function isUint8Array(value: unknown): value is Uint8Array {
  return typedArrayTag.call(value) === "Uint8Array"
}

function isConstructorPrototype(prototype: RuntimeObject): boolean {
  if (!Object.hasOwn(prototype, "constructor")) return false
  const constructor = prototype.constructor
  return isRuntimeFunction(constructor)
    && Object.getOwnPropertyDescriptor(constructor, "prototype")?.value === prototype
    // Object constructors have the same native representation across realms.
    // Exclude their prototypes while allowing classes that extend null.
    && Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Object)
}

function hasCallableMethod(value: RuntimeObject, key: string): boolean {
  if (Object.hasOwn(value, key)) {
    return isRuntimeFunction(value[key])
  }

  // Native class-based Sources keep their methods on a prototype. Treat a
  // prototype-backed object as a Source only when its immediate prototype is
  // an intentional constructor prototype. A plain object supplied through
  // Object.create({ ... }) has no own constructor and must not inherit a
  // Source marker from that object (or from any realm's Object.prototype).
  let prototype = Object.getPrototypeOf(value)
  while (prototype && isConstructorPrototype(prototype)) {
    if (Object.hasOwn(prototype, key)) return isRuntimeFunction(value[key])
    prototype = Object.getPrototypeOf(prototype)
  }
  return false
}

function isSourceName(input: ContentSourceInput): input is SourceName {
  return Object(input) !== input && Object.prototype.toString.call(input) === "[object String]"
}

function isComarkContentSource(input: ContentSourceInput): input is ComarkContentSource {
  return (
    isRuntimeObject(input)
    && hasCallableMethod(input, "getItem")
    && hasCallableMethod(input, "getItemRaw")
    && hasCallableMethod(input, "keys")
  )
}

function isSourceDefinition(input: ContentSourceInput): input is Source<string, unknown, object> {
  return (
    isRuntimeObject(input)
    && hasCallableMethod(input, "getKeys")
    && hasCallableMethod(input, "getItem")
  )
}

function configuredContentSource(input: ComarkContentSource, options: ContentSourceOptions): ComarkContentSource {
  const source: ComarkContentSource = {
    getItem: input.getItem.bind(input),
    getItemRaw: input.getItemRaw.bind(input),
    keys: input.keys.bind(input),
    prefix: options.prefix ?? input.prefix,
    schema: options.schema ?? input.schema,
  }
  if (input.watch) source.watch = input.watch.bind(input)
  return source
}

function getContentSourceFactory(source: ComarkContentSource): ContentSourceFactory | undefined {
  // SAFETY: Only adapters created below define this private symbol, and they store a ContentSourceFactory.
  return (source as ComarkContentSource & { [contentSourceFactory]?: ContentSourceFactory })[contentSourceFactory]
}

function contentSourceOptions(
  defaults: ContentSourceFactoryOptions,
  overrides: ContentSourceFactoryOptions,
): ContentSourceFactoryOptions {
  return {
    prefix: overrides.prefix ?? defaults.prefix,
    schema: overrides.schema ?? defaults.schema,
    commits: overrides.commits ?? defaults.commits,
  }
}

function createContentSourceFactory(
  sourceInput: Source<string, unknown, object> | SourceName | ContentSourceReader | (() => ContentSourceReader),
  defaults: ContentSourceFactoryOptions,
): ContentSourceFactory {
  const state: ContentSourceState = { latestSequence: 0, nextSequence: 0 }
  const factory: ContentSourceFactory = {
    create(overrides = {}) {
      const options = contentSourceOptions(defaults, overrides)
      let itemsPromise: Promise<Map<string, ContentSourceItem>> | undefined

      function loadItems() {
        if (!itemsPromise) {
          const sequence = ++state.nextSequence
          itemsPromise = (async () => {
            const nextItems = new Map<string, ContentSourceItem>()
            const revision = await options.commits?.revision()
            const currentReader = () => isSourceName(sourceInput)
              ? useSource(sourceInput)
              : isSourceDefinition(sourceInput)
                ? createSource(sourceInput)
                : isRuntimeFunction(sourceInput)
                  ? sourceInput()
                  : sourceInput
            for (const item of revision ? await options.commits!.files(revision) : await currentReader().items()) {
              const path = contentPath(item)
              if (nextItems.has(path)) {
                throw contentErrorDiagnostics.CONTENT_R0003({ message: `[vitehub] contentSource() received duplicate content path ${JSON.stringify(path)}.` })
              }
              nextItems.set(path, item)
            }
            if (sequence >= state.latestSequence) {
              state.latestItems = nextItems
              state.latestSequence = sequence
            }
            return nextItems
          })()
        }
        return itemsPromise
      }

      const source: ComarkContentSource = {
        async keys() {
          itemsPromise = undefined
          return [...(await loadItems()).keys()]
        },
        async getItem(key) {
          const path = normalizeContentSourcePath(key)
          const item = (await loadItems()).get(path)
          if (!item) throw contentErrorDiagnostics.CONTENT_R0004({ message: `[vitehub] contentSource() could not find ${JSON.stringify(key)}.` })
          return textContent(item)
        },
        async getItemRaw(key) {
          const path = normalizeContentSourcePath(key)
          let items = state.latestItems
          if (itemsPromise) {
            try {
              items = await itemsPromise
            } catch (error) {
              if (!items) throw error
            }
          } else if (!items) {
            items = await loadItems()
          }
          const item = items.get(path)
          if (!item) return
          return item.data ?? item.content
        },
      }
      if (options.prefix !== undefined) source.prefix = options.prefix
      if (options.schema !== undefined) source.schema = options.schema
      if (isSourceDefinition(sourceInput)) contentSourceDefinitions.set(source, sourceInput)
      Object.defineProperty(source, contentSourceFactory, {
        value: {
          create: (overrides = {}) => factory.create(contentSourceOptions(options, overrides)),
        } satisfies ContentSourceFactory,
      })
      return source
    },
  }
  return factory
}

/** The page options that `contentSource(input, { url, label, seo, markdown })` set, if it set a `url`. */
export function contentSourceRoute(input: ContentSourceInput | undefined): ContentSourceRoute | undefined {
  return isRuntimeObject(input) ? Reflect.get(input, contentSourceRouteKey) as ContentSourceRoute | undefined : undefined
}

/** The `url` that `contentSource(input, { url })` set, if any. */
export function contentSourceUrl(input: ContentSourceInput | undefined): ContentDocumentUrl | undefined {
  return contentSourceRoute(input)?.url
}

/** The `@vite-hub/source` Source definition behind an input, if any. */
export function contentSourceDefinition(input: ContentSourceInput): Source<string, unknown, object> | undefined {
  if (isSourceDefinition(input)) return input
  return isComarkContentSource(input) ? contentSourceDefinitions.get(input) : undefined
}

/** The `name` of the `@vite-hub/source` Source behind an input, such as `glob` or `files`, or undefined for other inputs. */
export function contentSourceKind(input: ContentSourceInput): string | undefined {
  return contentSourceDefinition(input)?.name
}

/**
 * The keys of the `@vite-hub/source` Source behind an input. Unlike the Comark Source's `keys()`, it reads no file
 * content. Inputs without a Source definition have no keys.
 */
export async function contentSourceKeys(input: ContentSourceInput): Promise<string[]> {
  const definition = contentSourceDefinition(input)
  return definition ? await createSource(definition).keys() : []
}

/** Adapt a Source to Comark Content, opening a fresh reader for each definition load. */
export function contentSource(input: ContentSourceInput, options: ContentSourceOptions = {}): ComarkContentSource {
  const inherited = contentSourceRoute(input)
  const { url = inherited?.url, label = inherited?.label, seo = inherited?.seo, markdown = inherited?.markdown, prefix, schema } = options
  const comarkOptions = { prefix, schema }
  if (url !== undefined && !isRuntimeFunction(url) && (String(url) !== url || !url.startsWith("/") || url.startsWith("//"))) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] contentSource({ url }) must be a path that starts with /, such as '/:id', or a function, received ${JSON.stringify(url)}.` })
  }
  if ((label !== undefined && (String(label) !== label || !label.trim())) || (seo !== undefined && !isRuntimeFunction(seo)) || (markdown !== undefined && !isRuntimeFunction(markdown))) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] contentSource({ label, seo, markdown }) takes label as text, and seo and markdown as functions." })
  }
  if (url === undefined && (label !== undefined || seo !== undefined || markdown !== undefined)) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] contentSource({ label, seo, markdown }) needs a url, such as '/:id': they describe the pages of the Source." })
  }
  let source: ComarkContentSource
  if (isComarkContentSource(input)) {
    const factory = getContentSourceFactory(input)
    source = factory
      ? factory.create(comarkOptions)
      : comarkOptions.prefix === undefined && comarkOptions.schema === undefined && url === undefined ? input : configuredContentSource(input, comarkOptions)
  }
  else {
    source = createContentSourceFactory(input, comarkOptions).create()
  }
  if (url !== undefined) {
    const route: ContentSourceRoute = { url, ...label === undefined ? {} : { label }, ...seo ? { seo } : {}, ...markdown ? { markdown } : {} }
    Object.defineProperty(source, contentSourceRouteKey, { value: route })
  }
  return source
}

/**
 * Create the Comark instance of one Source. With `snapshot`, the instance hydrates from the build-time snapshot on its
 * first read and keeps the Source as its origin. With `commits`, the instance serves one commit of a Source definition
 * from the commit cache.
 */
export function createContentInstance(name: string, input: ContentSourceInput, options: ContentOptions, snapshot?: ContentSnapshotLoader, commits?: ContentSourceCommits): ReturnType<typeof comarkContent> {
  const adapted = contentSource(input)
  const source = commits ? getContentSourceFactory(adapted)?.create({ commits }) ?? adapted : adapted
  options = {
    ...options,
    // A persistent Comark cache has no commit identity. Keep managed GitHub caches local to this instance.
    ...(commits && options.cache !== false ? { cache: { ...options.cache, driver: memory() } } : {}),
    plugins: options.plugins?.map(plugin => plugin && ({
      ...plugin,
      setup(context) {
        const methods = plugin.setup?.(context)
        if (methods) Object.assign(context, methods)
      },
    })),
  }
  const factory = getContentSourceFactory(source)
  const keys = () => contentSourceKeys(input)
  if (!factory) return comarkContent(name, { ...options, source: snapshot ? withContentSnapshot(source, snapshot, keys) : source })

  // Each async load retains its own Source reader, including parsers that outlive a failed load.
  const loads = new AsyncLocalStorage<ComarkContentSource>()
  const loaded = new WeakSet<ComarkContentSource>()
  let currentSource = source
  let nextSequence = 0
  let currentSequence = 0
  async function load<T>(run: () => Promise<T>): Promise<T> {
    const reader = factory!.create()
    const sequence = ++nextSequence
    const result = await loads.run(reader, run)
    // Cached reads do not load a reader. Only a successful load can replace this instance's raw Source.
    if (loaded.has(reader) && sequence >= currentSequence) {
      currentSource = reader
      currentSequence = sequence
    }
    return result
  }
  const scopedSource: ComarkContentSource = {
    ...source,
    async keys() {
      const reader = loads.getStore() ?? currentSource
      const keys = await reader.keys()
      loaded.add(reader)
      return keys
    },
    getItem: key => (loads.getStore() ?? currentSource).getItem(key),
    getItemRaw: key => (loads.getStore() ?? currentSource).getItemRaw(key),
  }
  const instance = comarkContent(name, { ...options, source: snapshot ? withContentSnapshot(scopedSource, snapshot, keys) : commits ? commits.documents(scopedSource) : scopedSource })
  const init = instance.init.bind(instance)
  const refresh = instance.refresh.bind(instance)
  const get = instance.get.bind(instance)
  instance.init = opts => loads.getStore() ? init(opts) : load(() => init(opts))
  instance.refresh = () => load(refresh)
  // SAFETY: The wrapper forwards the key and options without changing the generic document result.
  instance.get = ((key: string, opts?: ContentGetOptions) => load(() => get(key, opts))) as typeof instance.get
  return instance
}
