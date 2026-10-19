import { cacheBypassKey } from "../runtime/cache-bypass.ts"

/**
 * Nitro has no global hook that keeps one request out of its cache: `shouldBypassCache` is an option of each cached
 * handler or function, and `cache`/`swr` route rules create theirs internally. This plugin puts a thin module between
 * Nitro and its own cache module, `dist/runtime/internal/cache.mjs` in `nitro` (Nitro 3) and `nitropack` (Nitro 2),
 * so every cached handler, route rule, and cached function consults the checks registered with `addCacheBypass()`.
 * A bypassed call runs the handler or function directly: it reads no entry, writes none, and never joins another
 * request's pending render.
 */

const virtualPrefix = "\0vitehub-nitro-cache:"
const cacheModule = /[\\/](nitro|nitropack)[\\/]dist[\\/]runtime[\\/]internal[\\/]cache\.mjs$/
const nitroRuntime = /[\\/]nitro(?:pack)?[\\/]dist[\\/]runtime[\\/]/
const cacheImport = /(?:^|\/)cache\.mjs$/

interface ResolvedModule {
  external?: boolean | string
  id: string
}

interface ResolveContext {
  resolve(source: string, importer: string, options: Record<string, unknown>): Promise<ResolvedModule | null>
}

/** A Rollup and Vite plugin. Vite runs it before its own resolver; Nitro 2 runs user Rollup plugins before its own. */
export interface NitroCacheBypassPlugin {
  enforce: "pre"
  name: "vite-hub/nitro-cache-bypass"
  load(id: string): string | null
  resolveId(this: ResolveContext, source: string, importer: string | undefined, options?: Record<string, unknown>): Promise<string | null>
}

function seam(flavor: string, path: string): string {
  const module = JSON.stringify(path)
  const lines = [
    `import * as nitroCache from ${module}`,
    `export * from ${module}`,
    `const checks = globalThis[Symbol.for(${JSON.stringify(cacheBypassKey)})] ??= new Set()`,
    `function bypass() {`,
    `  for (const check of checks) if (check()) return true`,
    `  return false`,
    `}`,
  ]
  if (flavor === "nitro") {
    // ocache honors shouldBypassCache by calling the handler with the untouched request and storing nothing.
    lines.push(
      `function withBypass(options) {`,
      `  const own = options?.shouldBypassCache`,
      `  return { ...options, shouldBypassCache: (...args) => bypass() || (own ? own(...args) : false) }`,
      `}`,
      `export function defineCachedFunction(fn, options) {`,
      `  return nitroCache.defineCachedFunction(fn, withBypass(options))`,
      `}`,
      `export function defineCachedHandler(handler, options) {`,
      `  return nitroCache.defineCachedHandler(handler, withBypass(options))`,
      `}`,
    )
  }
  else {
    // Nitro 2 runs a bypassed handler on a copied event without request headers, so call the handler itself.
    lines.push(
      `export function defineCachedFunction(fn, options) {`,
      `  const cached = nitroCache.defineCachedFunction(fn, options)`,
      `  return (...args) => bypass() ? fn(...args) : cached(...args)`,
      `}`,
      `export const cachedFunction = defineCachedFunction`,
      `export function defineCachedEventHandler(handler, options) {`,
      `  const cached = nitroCache.defineCachedEventHandler(handler, options)`,
      `  const seamHandler = event => bypass() ? handler(event) : cached(event)`,
      `  seamHandler.__is_handler__ = true`,
      `  return seamHandler`,
      `}`,
      `export const cachedEventHandler = defineCachedEventHandler`,
    )
  }
  return `${lines.join("\n")}\n`
}

/** Route Nitro's cache module through ViteHub's cache-bypass seam. */
export function nitroCacheBypass(): NitroCacheBypassPlugin {
  return {
    name: "vite-hub/nitro-cache-bypass",
    enforce: "pre",
    async resolveId(source, importer, options = {}) {
      if (!importer || importer.startsWith(virtualPrefix) || !cacheImport.test(source) || !nitroRuntime.test(importer)) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved || resolved.external) return null
      // Another plugin's nested resolve can reach this hook again and hand back the seam's own id.
      if (resolved.id.startsWith(virtualPrefix)) return resolved.id
      const match = cacheModule.exec(resolved.id.split("?", 1)[0]!)
      return match ? `${virtualPrefix}${match[1]}:${resolved.id}` : null
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return null
      const rest = id.slice(virtualPrefix.length)
      const separator = rest.indexOf(":")
      return seam(rest.slice(0, separator), rest.slice(separator + 1))
    },
  }
}
