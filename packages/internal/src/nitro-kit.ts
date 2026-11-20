import { isRecordOrFunction as isRecord } from "./object.ts"

/**
 * The small internal seam between ViteHub packages and Nitro configuration.
 *
 * This is deliberately Nitro 3 specific. A future server adapter can satisfy
 * the same package-owned operations without making Nitro types part of the
 * ViteHub package contracts.
 */

export interface NitroServerHandler {
  handler: string
  /** Import the handler on its first request instead of when the server starts. */
  lazy?: boolean
  method?: string | string[]
  /**
   * The Nitro route meta. Nitro gives it to the request event as `event.context.matchedRoute.meta`. A route that checks
   * its own access uses `ownAccessHandlerMeta`.
   */
  meta?: Readonly<Record<string, unknown>>
  middleware?: boolean
  route?: string
}

/**
 * The route meta of a generated handler that checks its own access: it runs an app `authorize`, an explicit access
 * rule, or a signature check on every request. ViteHub Auth access routes leave a request that Nitro routed to such a
 * handler to the handler, and `checksOwnAccess(event)` of `vite-hub/auth/server` tells app middleware the same. A route
 * that accepts every request, such as a browser error sink, must not use it.
 */
export const ownAccessHandlerMeta: Readonly<{ vitehubAuthAccess: "handler" }> = Object.freeze({ vitehubAuthAccess: "handler" })

export interface NitroServerKit {
  readonly config: Record<string, unknown>
  addHandler(handler: NitroServerHandler, position?: "start" | "end"): void
  addPlugin(plugin: string, position?: "start" | "end"): void
}

function cloneArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : []
}

function sameHandler(left: Record<string, unknown>, right: NitroServerHandler): boolean {
  return left.handler === right.handler
    && left.route === right.route
    && left.method === right.method
    && left.middleware === right.middleware
}

/** Create a Nitro 3 configuration builder for generated ViteHub output. */
export function createNitroServerKit(value: unknown = {}): NitroServerKit {
  const config = isRecord(value)
    ? { ...value }
    : {}
  const handlers = cloneArray(config.handlers)
  const plugins = cloneArray(config.plugins)

  config.handlers = handlers
  config.plugins = plugins

  return {
    config,
    addHandler(handler, position = "end") {
      if (handlers.some(candidate => isRecord(candidate) && sameHandler(candidate, handler))) return
      if (position === "start") handlers.unshift({ ...handler })
      else handlers.push({ ...handler })
    },
    addPlugin(plugin, position = "end") {
      if (plugins.includes(plugin)) return
      if (position === "start") plugins.unshift(plugin)
      else plugins.push(plugin)
    },
  }
}

/** Add one module id to a Nitro or Rollup `external` option, in each form that option takes. */
export function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}
