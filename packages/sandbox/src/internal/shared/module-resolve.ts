import { resolveModule } from 'local-pkg'
import { resolvePathSync } from 'mlly'

export interface ResolvedModuleResult {
  ok: true
  path: string
}

export interface MissingModuleResult {
  ok: false
  error: string
}

function normalizePaths(paths?: string[]) {
  if (paths?.length)
    return paths

  if (typeof process !== 'undefined')
    return [process.cwd()]

  return []
}

function tryResolveFromRuntime(id: string): string | false | undefined {
  const requireResolver = (globalThis as { require?: { resolve?: (specifier: string) => string } }).require?.resolve
  if (typeof requireResolver !== 'function')
    return undefined

  try {
    return requireResolver(id)
  }
  catch {
    return false
  }
}

export function tryResolveModule(id: string, options: { paths?: string[] } = {}): ResolvedModuleResult | MissingModuleResult {
  const paths = normalizePaths(options.paths)

  const runtimeResolved = tryResolveFromRuntime(id)
  if (runtimeResolved === false)
    return { ok: false, error: `Unable to resolve module "${id}" using the active runtime resolver` }
  if (runtimeResolved)
    return { ok: true, path: runtimeResolved }

  const resolved = resolveModule(id, { paths })
  if (resolved)
    return { ok: true, path: resolved }

  for (const url of paths) {
    try {
      return { ok: true, path: resolvePathSync(id, { url }) }
    }
    catch {
      continue
    }
  }

  return {
    ok: false,
    error: paths.length > 0
      ? `Unable to resolve module "${id}" from ${paths.join(', ')}`
      : `Unable to resolve module "${id}" without explicit resolution paths`,
  }
}

const resolveCache = new Map<string, boolean>()

export function canResolveModule(moduleName: string, options?: { paths?: string[] }): boolean {
  const key = options?.paths ? `${moduleName}\0${options.paths.join('\0')}` : moduleName
  const cached = resolveCache.get(key)
  if (cached !== undefined)
    return cached
  const result = tryResolveModule(moduleName, options).ok
  resolveCache.set(key, result)
  return result
}

export function clearResolveCache(): void {
  resolveCache.clear()
}
