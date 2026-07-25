import { sourceNotFoundError, sourceError } from "./errors.ts"
import { decodeSourceContent, normalizeSafeSourcePath, normalizeSourcePath } from "./path.ts"

import type {
  ReadSourceOptions,
  ReadSourceResult,
  Source,
  SourceContext,
  SourceData,
  SourceItem,
  SourceKey,
  SourceListEntry,
  SourceMetadata,
  SourceName,
  SourceReader,
} from "./types.ts"

const sourceRegistry = new Map<string, Source>()

export function registerSource<const TName extends string, const TSource extends Source>(
  name: TName,
  source: TSource,
): TSource {
  sourceRegistry.set(name, source)
  return source
}

export function registerSources<const TSources extends Record<string, Source>>(sources: TSources): TSources {
  for (const [name, source] of Object.entries(sources)) {
    registerSource(name, source)
  }
  return sources
}

export function getRegisteredSource<TName extends SourceName>(
  name: TName,
): Source<SourceKey<TName>, SourceData<TName>, SourceMetadata<TName>> {
  const source = sourceRegistry.get(name)
  if (!source) throw sourceNotFoundError(name)
  return source as Source<SourceKey<TName>, SourceData<TName>, SourceMetadata<TName>>
}

export function clearSources(): void {
  sourceRegistry.clear()
}

function createSourceContext(name: string, context: Partial<SourceContext> = {}): SourceContext {
  return {
    abortSignal: context.abortSignal,
    rootDir: context.rootDir || process.cwd(),
    source: context.source || name,
    sourceRootDir: context.sourceRootDir,
    workspace: context.workspace,
  }
}

function createMissingContentError(key: string) {
  return sourceError(`[vitehub] Source item ${JSON.stringify(key)} does not provide readable content.`)
}

function isNestedUnder(path: string, prefix: string) {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`)
}

function createDirectorySet(paths: string[]) {
  const directories = new Set<string>()

  for (const path of paths) {
    const segments = normalizeSourcePath(path).split("/").filter(Boolean)
    for (let index = 1; index < segments.length; index++) {
      directories.add(segments.slice(0, index).join("/"))
    }
  }

  return directories
}

export function useSource<TName extends SourceName>(
  name: TName,
  context?: Partial<SourceContext>,
): SourceReader<TName> {
  const source = getRegisteredSource(name)
  const ctx = createSourceContext(name, context)
  let preparePromise: Promise<void> | undefined

  async function ensurePrepared() {
    if (!source.prepare) return
    preparePromise ||= source.prepare(ctx)
    await preparePromise
  }

  async function keys() {
    await ensurePrepared()
    return await source.getKeys(ctx)
  }

  async function get(
    key: SourceKey<TName>,
  ): Promise<SourceItem<SourceKey<TName>, SourceData<TName>, SourceMetadata<TName>>> {
    await ensurePrepared()
    return await source.getItem(key, ctx)
  }

  return {
    keys,
    get,
    async items() {
      await ensurePrepared()
      if (source.getItems) return await source.getItems(ctx)
      return await Promise.all((await keys()).map(get))
    },
    async read<TOptions extends ReadSourceOptions | undefined = undefined>(
      key: SourceKey<TName>,
      options?: TOptions,
    ): Promise<ReadSourceResult<TOptions>> {
      const item = await get(key)
      if (typeof item.content === "undefined") throw createMissingContentError(key)
      return decodeSourceContent(item.content, options)
    },
    async meta(key) {
      await ensurePrepared()
      return await source.getMeta?.(key, ctx)
    },
    async exists(key) {
      return (await keys()).includes(key)
    },
    async list(prefix = "") {
      await ensurePrepared()
      const normalizedPrefix = prefix ? normalizeSafeSourcePath(prefix, { allowEmpty: true }) : ""
      const sourceKeys = await keys()
      const directories = createDirectorySet(sourceKeys)
      const result = new Map<string, SourceListEntry<SourceKey<TName>>>()

      for (const directory of directories) {
        if (directory === normalizedPrefix) continue
        if (!isNestedUnder(directory, normalizedPrefix)) continue
        const rest = normalizeSourcePath(directory.slice(normalizedPrefix.length)).replace(/^\//, "")
        if (rest.includes("/")) continue
        result.set(directory, { key: directory as SourceKey<TName>, type: "directory" })
      }

      for (const key of sourceKeys) {
        if (key === normalizedPrefix) continue
        if (!isNestedUnder(key, normalizedPrefix)) continue
        const rest = normalizeSourcePath(key.slice(normalizedPrefix.length)).replace(/^\//, "")
        if (rest.includes("/")) continue
        result.set(key, { key, type: "file" })
      }

      return [...result.values()].sort((left, right) => left.key.localeCompare(right.key))
    },
  }
}
