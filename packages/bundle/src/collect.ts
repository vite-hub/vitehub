import { gzipSync } from "node:zlib"

import { allocateBytes } from "./bytes.ts"
import { moduleId } from "./groups.ts"

import type { BundleChunk, BundleEnvironmentReport, BundleModule } from "./types.ts"

/** The parts of a Rolldown output chunk that the report reads. */
export interface OutputChunkLike {
  type: "chunk"
  fileName: string
  code: string
  isEntry: boolean
  facadeModuleId: string | null
  imports: string[]
  modules: Record<string, { renderedLength: number }>
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
}

function isChunk(output: unknown): output is OutputChunkLike {
  return typeof output === "object" && output !== null && Reflect.get(output, "type") === "chunk"
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
  for (const chunk of chunks) {
    for (const [id, module] of Object.entries(chunk.modules)) if (module.renderedLength > 0) ids.set(id, moduleId(id, options.root, packages))
  }
  const edges = createEdgeReader(ids, options.getModuleInfo)

  const rows: BundleChunk[] = chunks.map((chunk) => {
    const bytes = Buffer.byteLength(chunk.code)
    const entries = Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0)
    // `page.vue` and `page.vue?vue&type=script` become one module.
    const merged = new Map<string, { rendered: number, imports: Set<string>, dynamicImports: Set<string>, entry: boolean }>()
    for (const [raw, module] of entries) {
      const id = ids.get(raw)!
      const row = merged.get(id) ?? { rendered: 0, imports: new Set<string>(), dynamicImports: new Set<string>(), entry: false }
      const out = edges(raw)
      row.rendered += module.renderedLength
      for (const next of out.imports) row.imports.add(next)
      for (const next of out.dynamicImports) row.dynamicImports.add(next)
      row.entry ||= options.getModuleInfo(raw)?.isEntry ?? chunk.facadeModuleId === raw
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
    return { file: chunk.fileName, bytes, gzip: gzipSync(chunk.code).length, entry: chunk.isEntry, startup: startup.has(chunk.fileName), modules }
  }).sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file))

  return {
    schemaVersion: 1,
    build: options.build,
    environment: options.environment,
    side: options.side,
    outDir: relativeTo(options.root, options.outDir),
    chunks: rows,
  }
}
