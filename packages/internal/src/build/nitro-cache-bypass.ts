import { cacheBypassKey } from "../runtime/cache-bypass.ts"

/**
 * Nitro has no global hook that keeps one request out of its cache: `shouldBypassCache` is an option of each cached
 * handler or function, and `cache`/`swr` route rules create theirs internally. This plugin puts a thin module between
 * Nitro and its own cache module, `nitro/dist/runtime/internal/cache.mjs`, so every cached handler, route rule, and cached function consults the checks registered with `addCacheBypass()`.
 * Nitro builds its `cache` route rule with h3's ocache rule handler instead of its cache module, so the plugin also
 * wraps that rule in `dist/runtime/internal/route-rule-handlers.mjs`.
 * A bypassed call runs the handler or function directly: it reads no entry, writes none, and never joins another
 * request's pending render.
 */

const virtualPrefix = "\0vitehub-nitro-cache:"
const cacheModule = /[\\/]nitro[\\/]dist[\\/]runtime[\\/]internal[\\/]cache\.mjs$/
const nitroRuntime = /[\\/]nitro[\\/]dist[\\/]runtime[\\/]/
const cacheImport = /(?:^|\/)cache\.mjs$/
const ruleHandlersModule = /[\\/]nitro[\\/]dist[\\/]runtime[\\/]internal[\\/]route-rule-handlers\.mjs$/
const ruleHandlersImport = /(?:^|\/)route-rule-handlers(?:\.mjs)?$/
const seamImports = /(?:^|\/)(?:cache\.mjs|route-rule-handlers(?:\.mjs)?)$/
const seamModules = /^\0vitehub-nitro-cache:/

interface ResolvedModule {
  external?: boolean | string
  id: string
}

interface ResolveContext {
  resolve(source: string, importer: string, options: Record<string, unknown>): Promise<ResolvedModule | null>
}

/** A Rollup and Vite plugin. Vite runs it before its own resolver. */
export interface NitroCacheBypassPlugin {
  enforce: "pre"
  name: "vite-hub/nitro-cache-bypass"
  load: {
    filter: { id: RegExp }
    handler(id: string): string | null
  }
  resolveId: {
    filter: { id: RegExp }
    handler(this: ResolveContext, source: string, importer: string | undefined, options?: Record<string, unknown>): Promise<string | null>
  }
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
  if (flavor === "rules") {
    // h3 skips a rule by calling `next()`, which runs the route handler without the cache.
    lines.push(
      `export const cache = {`,
      `  ...nitroCache.cache,`,
      `  handler: (rule) => {`,
      `    const cached = nitroCache.cache.handler(rule)`,
      `    return (event, next) => bypass() ? next() : cached(event, next)`,
      `  },`,
      `}`,
    )
  }
  else {
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
  return `${lines.join("\n")}\n`
}

/** Route Nitro's cache module through ViteHub's cache-bypass seam. */
export function nitroCacheBypass(): NitroCacheBypassPlugin {
  return {
    name: "vite-hub/nitro-cache-bypass",
    enforce: "pre",
    resolveId: {
      filter: { id: seamImports },
      async handler(source, importer, options = {}) {
        if (!importer || importer.startsWith(virtualPrefix)) return null
        // Nitro 3 imports its rule handlers from the generated routing module, which is not in its runtime folder.
        const rules = ruleHandlersImport.test(source)
        if (!rules && (!cacheImport.test(source) || !nitroRuntime.test(importer))) return null
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        if (!resolved || resolved.external) return null
        // Another plugin's nested resolve can reach this hook again and hand back the seam's own id.
        if (resolved.id.startsWith(virtualPrefix)) return resolved.id
        const path = resolved.id.split("?", 1)[0]!
        if (rules) return ruleHandlersModule.test(path) ? `${virtualPrefix}rules:${resolved.id}` : null
        return cacheModule.test(path) ? `${virtualPrefix}nitro:${resolved.id}` : null
      },
    },
    load: {
      filter: { id: seamModules },
      handler(id) {
        if (!id.startsWith(virtualPrefix)) return null
        const rest = id.slice(virtualPrefix.length)
        const separator = rest.indexOf(":")
        return seam(rest.slice(0, separator), rest.slice(separator + 1))
      },
    },
  }
}
