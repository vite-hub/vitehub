import { sourceError } from "./errors.ts"
import { decodeSourceContent, normalizeSafeSourcePath, normalizeSourcePath } from "./path.ts"

import type {
  ReadSourceOptions,
  ReadSourceResult,
  Source,
  SourceContext,
  SourceItem,
  SourceListEntry,
  SourceReader,
  SourceRevision,
} from "./types.ts"

function createSourceContext(name: string, context: Partial<SourceContext> = {}): SourceContext {
  return {
    abortSignal: context.abortSignal,
    revision: context.revision,
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

function createDirectorySet(paths: string[], prefix: string) {
  const directories = new Set<string>()
  const start = prefix ? prefix.length + 1 : 0

  for (const path of paths) {
    const normalized = normalizeSourcePath(path).split("/").filter(Boolean).join("/")
    if (prefix && !normalized.startsWith(`${prefix}/`)) continue
    const end = normalized.indexOf("/", start)
    if (end !== -1) directories.add(normalized.slice(0, end))
  }

  return directories
}

export function createSource<const TSource extends Source>(
  source: TSource,
  context?: Partial<SourceContext>,
): SourceReader<TSource>
export function createSource(source: Source, context?: Partial<SourceContext>) {
  return openSource(() => source, source.name, context)
}

/** A reader whose Source loads on its first operation, such as the file of a Source name. */
export function openSource(load: () => Source | Promise<Source>, name: string, context?: Partial<SourceContext>): SourceReader<Source> {
  const ctx = createSourceContext(name, context)
  let revisionPromise: Promise<SourceRevision | undefined> | undefined
  let preparePromise: Promise<void> | undefined

  async function revision() {
    if (ctx.revision) return ctx.revision
    revisionPromise ||= Promise.resolve(load()).then(source => source.resolveRevision?.(ctx))
    const resolved = await revisionPromise
    if (resolved) ctx.revision = resolved
    return resolved
  }

  async function prepared(): Promise<Source> {
    await revision()
    const source = await load()
    if (!source.prepare) return source
    preparePromise ||= source.prepare(ctx)
    await preparePromise
    return source
  }

  async function keys() {
    return await (await prepared()).getKeys(ctx)
  }

  async function get(
    key: string,
  ): Promise<SourceItem> {
    return await (await prepared()).getItem(key, ctx)
  }

  const reader = {
    revision,
    keys,
    get,
    async items() {
      const source = await prepared()
      if (source.getItems) return await source.getItems(ctx)
      return await Promise.all((await keys()).map(get))
    },
    async read<TOptions extends ReadSourceOptions | undefined = undefined>(
      key: string,
      options?: TOptions,
    ): Promise<ReadSourceResult<TOptions>> {
      const item = await get(key)
      if (item.content === undefined) throw createMissingContentError(key)
      return decodeSourceContent(item.content, options)
    },
    async meta(key: string) {
      return await (await prepared()).getMeta?.(key, ctx)
    },
    async exists(key: string) {
      return (await keys()).includes(key)
    },
    async list(prefix = "") {
      await prepared()
      const normalizedPrefix = prefix
        ? normalizeSafeSourcePath(prefix, { allowEmpty: true }).split("/").filter(Boolean).join("/")
        : ""
      const sourceKeys = await keys()
      const directories = createDirectorySet(sourceKeys, normalizedPrefix)
      const result = new Map<string, SourceListEntry<string>>()

      for (const directory of directories) {
        result.set(directory, { key: directory, type: "directory" })
      }

      for (const key of sourceKeys) {
        const normalizedKey = normalizeSourcePath(key).split("/").filter(Boolean).join("/")
        if (normalizedKey === normalizedPrefix) continue
        if (!isNestedUnder(normalizedKey, normalizedPrefix)) continue
        const rest = normalizedKey.slice(normalizedPrefix.length).replace(/^\//, "")
        if (rest.includes("/")) continue
        result.delete(normalizedKey)
        result.set(key, { key, type: "file" })
      }

      return [...result.values()].sort((left, right) => left.key.localeCompare(right.key))
    },
  }
  return reader
}
