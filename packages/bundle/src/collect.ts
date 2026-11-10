import { gzipSync } from "node:zlib"

import { allocateBytes } from "./bytes.ts"
import { moduleId } from "./groups.ts"

import type { PageRoute } from "./routes.ts"
import type { BundleChunk, BundleEnvironmentReport, BundleFile, BundleModule, BundleRouteOptions } from "./types.ts"

/** The parts of a Rolldown output chunk that the report reads. */
export interface OutputChunkLike {
  type: "chunk"
  fileName: string
  code: string
  isEntry: boolean
  facadeModuleId: string | null
  imports: string[]
  modules: Record<string, { renderedLength: number }>
  /** Vite adds the CSS files that load with the chunk. */
  viteMetadata?: { importedCss?: ReadonlySet<string> }
}

interface OutputAssetLike {
  type: "asset"
  fileName: string
  source: string | Uint8Array
}

/** The parts of Rolldown's `getModuleInfo()` that the report reads. */
export interface ModuleInfoLike {
  importedIds: readonly string[]
  dynamicallyImportedIds: readonly string[]
  isEntry: boolean
}

export interface CollectOptions {
  build: string
  environment: string
  side: "client" | "server"
  root: string
  /** Absolute output folder. */
  outDir: string
  getModuleInfo: (id: string) => ModuleInfoLike | null | undefined
  /** The page routes of the app, with absolute component files. Only the client report keeps them. */
  routes?: readonly PageRoute[]
  routeOptions?: BundleRouteOptions
}

function isChunk(output: unknown): output is OutputChunkLike {
  return typeof output === "object" && output !== null && Reflect.get(output, "type") === "chunk"
}

function isCssAsset(output: unknown): output is OutputAssetLike {
  return typeof output === "object" && output !== null && Reflect.get(output, "type") === "asset"
    && String(Reflect.get(output, "fileName")).endsWith(".css")
}

function cssFiles(bundle: Record<string, unknown>): BundleFile[] {
  return Object.values(bundle).filter(isCssAsset).map((asset) => {
    const source = typeof asset.source === "string" ? Buffer.from(asset.source) : asset.source
    return { file: asset.fileName, bytes: source.byteLength, gzip: gzipSync(source).length }
  }).sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file))
}

function relativeTo(root: string, path: string): string {
  const base = root.replace(/\\/g, "/").replace(/\/$/, "")
  const normalized = path.replace(/\\/g, "/")
  return normalized === base ? "." : normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized
}

interface Edges {
  imports: Set<string>
  dynamicImports: Set<string>
  complete: boolean
}

/**
 * Reads the imports of a module as report ids. The bundler drops modules that leave no code, such as a package index
 * that only re-exports, so an import of such a module continues to the modules that it imports. An edge is dynamic
 * when one step on the way is `import()`.
 */
function createEdgeReader(ids: ReadonlyMap<string, string>, getModuleInfo: CollectOptions["getModuleInfo"]): (raw: string) => Edges {
  const through = new Map<string, Edges>()
  const visit = (raw: string, visiting: Set<string>): Edges => {
    const cached = through.get(raw)
    if (cached) return cached
    const result: Edges = { imports: new Set(), dynamicImports: new Set(), complete: !visiting.has(raw) }
    if (!result.complete) return result
    visiting.add(raw)
    const info = getModuleInfo(raw)
    const add = (next: string, dynamic: boolean) => {
      const id = ids.get(next)
      if (id) {
        (dynamic ? result.dynamicImports : result.imports).add(id)
        return
      }
      const nested = visit(next, visiting)
      result.complete &&= nested.complete
      for (const found of nested.imports) (dynamic ? result.dynamicImports : result.imports).add(found)
      for (const found of nested.dynamicImports) result.dynamicImports.add(found)
    }
    for (const next of info?.importedIds ?? []) add(next, false)
    for (const next of info?.dynamicallyImportedIds ?? []) add(next, true)
    visiting.delete(raw)
    // A recursive edge truncates this traversal. Another entry must be able to read it afresh.
    if (result.complete) through.set(raw, result)
    return result
  }
  return raw => visit(raw, new Set())
}

/** Reads one build's output: the bytes of each chunk, the share of each module, and the startup files. */
export function collectEnvironmentReport(bundle: Record<string, unknown>, options: CollectOptions): BundleEnvironmentReport {
  const chunks = Object.values(bundle).filter(isChunk)
  const byFile = new Map(chunks.map(chunk => [chunk.fileName, chunk]))
  const startup = new Set<string>()
  const pending = chunks.filter(chunk => chunk.isEntry).map(chunk => chunk.fileName)
  while (pending.length) {
    const file = pending.pop()!
    if (startup.has(file)) continue
    startup.add(file)
    pending.push(...byFile.get(file)?.imports ?? [])
  }
  const ids = new Map<string, string>()
  const packages = new Map<string, string | undefined>()
  const isEntry = (id: string, chunk: OutputChunkLike) => options.getModuleInfo(id)?.isEntry ?? chunk.facadeModuleId === id
  for (const chunk of chunks) {
    // Entry facades can render no code while still providing the root of the import graph.
    for (const [id, module] of Object.entries(chunk.modules)) if (module.renderedLength > 0 || isEntry(id, chunk)) ids.set(id, moduleId(id, options.root, packages))
  }
  const edges = createEdgeReader(ids, options.getModuleInfo)
  const client = options.side === "client"

  const rows: BundleChunk[] = chunks.map((chunk) => {
    const bytes = Buffer.byteLength(chunk.code)
    const entries = Object.entries(chunk.modules).filter(([id]) => ids.has(id))
    // `page.vue` and `page.vue?vue&type=script` become one module.
    const merged = new Map<string, { rendered: number, imports: Set<string>, dynamicImports: Set<string>, entry: boolean }>()
    for (const [raw, module] of entries) {
      const id = ids.get(raw)!
      const row = merged.get(id) ?? { rendered: 0, imports: new Set<string>(), dynamicImports: new Set<string>(), entry: false }
      const out = edges(raw)
      row.rendered += module.renderedLength
      for (const next of out.imports) row.imports.add(next)
      for (const next of out.dynamicImports) row.dynamicImports.add(next)
      row.entry ||= isEntry(raw, chunk)
      merged.set(id, row)
    }
    const shares = allocateBytes([...merged.values()].map(row => row.rendered), bytes)
    const modules: BundleModule[] = [...merged].map(([id, row], index) => ({
      id,
      // Minification and chunk glue change the size after rendering, so each module gets its share of the file.
      bytes: shares[index]!,
      imports: [...row.imports].filter(next => next !== id).sort(),
      dynamicImports: [...row.dynamicImports].filter(next => next !== id && !row.imports.has(next)).sort(),
      entry: row.entry,
    })).sort((left, right) => right.bytes - left.bytes || left.id.localeCompare(right.id))
    const css = client ? [...chunk.viteMetadata?.importedCss ?? []].sort() : []
    return {
      file: chunk.fileName,
      bytes,
      gzip: gzipSync(chunk.code).length,
      entry: chunk.isEntry,
      startup: startup.has(chunk.fileName),
      imports: [...chunk.imports].sort(),
      ...(css.length ? { css } : {}),
      modules,
    }
  }).sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file))
  const css = client ? cssFiles(bundle) : []
  const unavailable = options.routeOptions?.unavailable ?? options.routes?.find(route => route.unavailable)?.unavailable
  const routeOptions = unavailable ? { ...options.routeOptions, unavailable } : options.routeOptions
  const routes = client && !unavailable ? options.routes?.map((route) => {
    let files = route.files
    const layout = route.layout
    if (layout) {
      const pages = new Set(files.filter(file => file !== layout.file).map(file => moduleId(file, options.root, packages)))
      const loaded = new Set<string>()
      const pending = rows.filter(chunk => chunk.startup || chunk.modules.some(module => pages.has(module.id)))
      while (pending.length) {
        const chunk = pending.pop()!
        if (loaded.has(chunk.file)) continue
        loaded.add(chunk.file)
        pending.push(...rows.filter(candidate => chunk.imports?.includes(candidate.file)))
      }
      const renderer = moduleId(layout.component, options.root, packages)
      const usesLayout = rows.some(chunk => loaded.has(chunk.file) && chunk.modules.some(module => module.id === renderer))
      if (!usesLayout) files = files.filter(file => file !== layout.file)
    }
    return { path: route.path, components: files.map(file => moduleId(file, options.root, packages)) }
  }) : undefined

  return {
    schemaVersion: 1,
    build: options.build,
    environment: options.environment,
    side: options.side,
    outDir: relativeTo(options.root, options.outDir),
    chunks: rows,
    ...(css.length ? { css } : {}),
    ...(routes?.length ? { routes } : {}),
    ...(client && routeOptions ? { routeOptions } : {}),
  }
}
