import { AsyncLocalStorage } from "node:async_hooks"

import { comarkContent } from "comark-content"
import type { ContentGetOptions, ContentOptions, JsonSchema, Source as ComarkContentSource } from "comark-content"
import { createSource, useSource } from "@vite-hub/source"
import type { Source, SourceItem, SourceName } from "@vite-hub/source"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

export interface ContentSourceOptions {
  prefix?: string
  schema?: JsonSchema
}

type ContentSourceItem = SourceItem<string, unknown, object>
type RuntimeObject = Record<string, unknown>
type ContentSourceFactory = {
  create(options?: ContentSourceOptions): ComarkContentSource
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

function normalizeContentSourcePath(path = ""): string {
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
  return normalizeContentSourcePath(item.path || item.key)
}

function textContent(item: ContentSourceItem): string {
  if (item.content instanceof Uint8Array) return new TextDecoder().decode(item.content)
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
  defaults: ContentSourceOptions,
  overrides: ContentSourceOptions,
): ContentSourceOptions {
  return {
    prefix: overrides.prefix ?? defaults.prefix,
    schema: overrides.schema ?? defaults.schema,
  }
}

function createContentSourceFactory(
  sourceInput: Source<string, unknown, object> | SourceName | ContentSourceReader | (() => ContentSourceReader),
  defaults: ContentSourceOptions,
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
            const currentReader = isSourceName(sourceInput)
              ? useSource(sourceInput)
              : isSourceDefinition(sourceInput)
                ? createSource(sourceInput)
                : isRuntimeFunction(sourceInput)
                  ? sourceInput()
                  : sourceInput
            for (const item of await currentReader.items()) {
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

/** Adapt a Source to Comark Content, opening a fresh reader for each definition load. */
export function contentSource(input: ContentSourceInput, options: ContentSourceOptions = {}): ComarkContentSource {
  if (isComarkContentSource(input)) {
    const factory = getContentSourceFactory(input)
    if (factory) return factory.create(options)
    return options.prefix === undefined && options.schema === undefined ? input : configuredContentSource(input, options)
  }
  return createContentSourceFactory(input, options).create()
}

export function createContentInstance(name: string, input: ContentSourceInput, options: ContentOptions): ReturnType<typeof comarkContent> {
  const source = contentSource(input)
  options = {
    ...options,
    plugins: options.plugins?.map(plugin => plugin && ({
      ...plugin,
      setup(context) {
        const methods = plugin.setup?.(context)
        if (methods) Object.assign(context, methods)
      },
    })),
  }
  const factory = getContentSourceFactory(source)
  if (!factory) return comarkContent(name, { ...options, source })

  // Each async load retains its own Source reader, including parsers that outlive a failed load.
  const loads = new AsyncLocalStorage<ComarkContentSource>()
  const scopedSource: ComarkContentSource = {
    ...source,
    keys: () => (loads.getStore() ?? source).keys(),
    getItem: key => (loads.getStore() ?? source).getItem(key),
    getItemRaw: key => (loads.getStore() ?? source).getItemRaw(key),
  }
  const instance = comarkContent(name, { ...options, source: scopedSource })
  const init = instance.init.bind(instance)
  const refresh = instance.refresh.bind(instance)
  const get = instance.get.bind(instance)
  instance.init = opts => loads.getStore() ? init(opts) : loads.run(factory.create(), () => init(opts))
  instance.refresh = () => loads.run(factory.create(), refresh)
  // SAFETY: The wrapper forwards the key and options without changing the generic document result.
  instance.get = ((key: string, opts?: ContentGetOptions) => loads.run(factory.create(), () => get(key, opts))) as typeof instance.get
  return instance
}
