import { resolveModule } from 'local-pkg'
import { resolvePathSync } from 'mlly'

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

/** The resolved path of `id`, or `undefined` when no resolver finds it. */
export function tryResolveModule(id: string, options: { paths?: string[] } = {}): string | undefined {
  const paths = normalizePaths(options.paths)

  const runtimeResolved = tryResolveFromRuntime(id)
  if (runtimeResolved === false)
    return undefined
  if (runtimeResolved)
    return runtimeResolved

  const resolved = resolveModule(id, { paths })
  if (resolved)
    return resolved

  for (const url of paths) {
    try {
      return resolvePathSync(id, { url })
    }
    catch {
      continue
    }
  }

  return undefined
}

const resolveCache = new Map<string, boolean>()

export function canResolveModule(moduleName: string, options?: { paths?: string[] }): boolean {
  const key = options?.paths ? `${moduleName}\0${options.paths.join('\0')}` : moduleName
  const cached = resolveCache.get(key)
  if (cached !== undefined)
    return cached
  const resolved = tryResolveModule(moduleName, options) !== undefined
  resolveCache.set(key, resolved)
  return resolved
}

export function clearResolveCache(): void {
  resolveCache.clear()
}
