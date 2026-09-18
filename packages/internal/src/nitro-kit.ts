/**
 * The small internal seam between ViteHub packages and Nitro configuration.
 *
 * This is deliberately Nitro 3 specific. A future server adapter can satisfy
 * the same package-owned operations without making Nitro types part of the
 * ViteHub package contracts.
 */

export interface NitroServerHandler {
  handler: string
  method?: string | string[]
  middleware?: boolean
  route?: string
}

export interface NitroServerKit {
  readonly config: Record<string, unknown>
  addHandler(handler: NitroServerHandler, position?: "start" | "end"): void
  addPlugin(plugin: string, position?: "start" | "end"): void
}

function cloneArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
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
