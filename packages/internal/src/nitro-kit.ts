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
   * its own access uses `ownAccessRouteMeta`. The type is `object` because Nitro's `NitroRouteMeta` has no index
   * signature.
   */
  meta?: object
  middleware?: boolean
  route?: string
}

/**
 * The route meta of a ViteHub handler that Auth access routes leave alone, such as the Console RPC. The handler takes
 * only its own signed requests and one-time links, so app access rules do not apply to it.
 */
export const ownAccessHandlerMeta: Readonly<{ vitehubAuthAccess: "handler" }> = Object.freeze({ vitehubAuthAccess: "handler" })

/**
 * The route meta of a generated handler that checks access on every request, even when the app adds no rule: a required
 * `authorize` policy, an explicit `access` rule, a required access token, or a signature. Auth access routes still apply
 * to it, so an app rule stays in force. `checksOwnAccess(event)` of `vite-hub/auth` reads it, so app middleware can skip
 * the route. A route that can run without a check, such as a browser error sink, an optional `authorize`, or a webhook
 * with `secret: false`, must not use it.
 */
export const ownAccessRouteMeta: Readonly<{ vitehubOwnAccess: true }> = Object.freeze({ vitehubOwnAccess: true })

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
