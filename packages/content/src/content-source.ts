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
type ContentSourceFactoryOptions = Omit<ContentSourceOptions, "url"> & { commits?: ContentSourceCommits }
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
const contentSourceUrlKey = Symbol("vitehub.contentSourceUrl")
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

      let knownReader: { get(key: string): Promise<ContentSourceItem> } | undefined
      // A path that the last full load saw is read alone. Other paths, such as a new file, load every item.
      async function readKnownItem(path: string) {
        const known = state.latestItems?.get(path)
        if (!known || itemsPromise || options.commits) return
        // One reader per load keeps every read of a load on one revision.
        knownReader ??= isSourceName(sourceInput) ? useSource(sourceInput) : isSourceDefinition(sourceInput) ? createSource(sourceInput) : undefined
        if (!knownReader) return
        // A failed read, such as a deleted file, falls back to the full load, which reports real errors.
        try {
          const item = await knownReader.get(known.key)
          if (contentPath(item) !== path) return
          state.latestItems?.set(path, item)
          return item
        } catch {
          return undefined
        }
      }

      const source: ComarkContentSource = {
        async keys() {
          itemsPromise = undefined
          return [...(await loadItems()).keys()]
        },
        async getItem(key) {
          const path = normalizeContentSourcePath(key)
          const item = await readKnownItem(path) ?? (await loadItems()).get(path)
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

/** The `url` that `contentSource(input, { url })` set, if any. */
export function contentSourceUrl(input: ContentSourceInput | undefined): ContentDocumentUrl | undefined {
  return isRuntimeObject(input) ? Reflect.get(input, contentSourceUrlKey) as ContentDocumentUrl | undefined : undefined
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
  const { url = contentSourceUrl(input), prefix, schema } = options
  const comarkOptions = { prefix, schema }
  if (url !== undefined && !isRuntimeFunction(url) && (String(url) !== url || !url.startsWith("/") || url.startsWith("//"))) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] contentSource({ url }) must be a path that starts with /, such as '/:id', or a function, received ${JSON.stringify(url)}.` })
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
  if (url !== undefined) Object.defineProperty(source, contentSourceUrlKey, { value: url })
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
  const scopedSource: ComarkContentSource = {
    ...source,
    keys: () => (loads.getStore() ?? source).keys(),
    getItem: key => (loads.getStore() ?? source).getItem(key),
    getItemRaw: key => (loads.getStore() ?? source).getItemRaw(key),
  }
  const instance = comarkContent(name, { ...options, source: snapshot ? withContentSnapshot(scopedSource, snapshot, keys) : commits ? commits.documents(scopedSource) : scopedSource })
  const init = instance.init.bind(instance)
  const refresh = instance.refresh.bind(instance)
  const get = instance.get.bind(instance)
  instance.init = opts => loads.getStore() ? init(opts) : loads.run(factory.create(), () => init(opts))
  instance.refresh = () => loads.run(factory.create(), refresh)
  // SAFETY: The wrapper forwards the key and options without changing the generic document result.
  instance.get = ((key: string, opts?: ContentGetOptions) => loads.run(factory.create(), () => get(key, opts))) as typeof instance.get
  return instance
}
