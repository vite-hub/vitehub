import { resolveModule } from 'local-pkg'
import { resolvePathSync } from 'mlly'

export type ModuleResolveResult =
  | [error: null, path: string]
  | [error: Error, path: undefined]

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

export function tryResolveModule(id: string, options: { paths?: string[] } = {}): ModuleResolveResult {
  const paths = normalizePaths(options.paths)

  const runtimeResolved = tryResolveFromRuntime(id)
  if (runtimeResolved === false)
    return [new Error(`Unable to resolve module "${id}" using the active runtime resolver`), undefined]
  if (runtimeResolved)
    return [null, runtimeResolved]

  const resolved = resolveModule(id, { paths })
  if (resolved)
    return [null, resolved]

  for (const url of paths) {
    try {
      return [null, resolvePathSync(id, { url })]
    }
    catch {
      continue
    }
  }

  return [new Error(
    paths.length > 0
      ? `Unable to resolve module "${id}" from ${paths.join(', ')}`
      : `Unable to resolve module "${id}" without explicit resolution paths`,
  ), undefined]
}

const resolveCache = new Map<string, boolean>()

export function canResolveModule(moduleName: string, options?: { paths?: string[] }): boolean {
  const key = options?.paths ? `${moduleName}\0${options.paths.join('\0')}` : moduleName
  const cached = resolveCache.get(key)
  if (cached !== undefined)
    return cached
  const [error] = tryResolveModule(moduleName, options)
  const resolved = error === null
  resolveCache.set(key, resolved)
  return resolved
}

export function clearResolveCache(): void {
  resolveCache.clear()
}
