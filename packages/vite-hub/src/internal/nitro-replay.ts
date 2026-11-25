import { isPlainObject as isRecord } from "@vite-hub/internal/object"
import type { HookHandler, Plugin } from "vite"

import { cloudflareEmailDevShimSource, cloudflareWorkersDevShimSource } from "../cloudflare-workers-dev-shim.injected.ts"

/** Node stubs for the Cloudflare runtime modules that ViteHub's generated server code imports. */
export const cloudflareDevShims = {
  "cloudflare:email": { file: "cloudflare-email.dev.mjs", source: cloudflareEmailDevShimSource },
  "cloudflare:workers": { file: "cloudflare-workers.dev.mjs", source: cloudflareWorkersDevShimSource },
}

export function isCloudflareDevShim(id: string): id is keyof typeof cloudflareDevShims {
  return Object.hasOwn(cloudflareDevShims, id)
}

type AgentDefinitionTransform = (code: string, id: string, options: {
  root: string
  serverDirs?: string[]
  resolve?: (specifier: string, importer: string) => Promise<string | undefined>
}) => Promise<string | undefined>

export const nitroRuntimeResolverNames = new Set([
  "@vite-hub/auth/vite",
  "@vite-hub/blob/vite",
  "@vite-hub/browser/vite",
  "@vite-hub/email/vite",
  "@vite-hub/i18n/vite",
  "@vite-hub/kv/vite",
  "@vite-hub/markdown-template/vite",
  "@vite-hub/realtime/vite",
  "@vite-hub/schedule/vite",
  "@vite-hub/source/vite",
  "vite-hub/optional-owner-imports",
  "vite-hub/cloudflare-sh-syntax",
  "vite-hub/durability",
  "vite-hub/cloudflare-pkce-challenge",
  "vite-hub/unavailable-services",
])

export const nitroServerTransformNames = new Set([
  "@vite-hub/env/vite",
  "@vite-hub/i18n/vite",
  "@vite-hub/schedule/vite",
  "@vite-hub/source/vite",
  "@vite-hub/workflow/vite",
])

export const nitroConfigResolvedNames = new Set([
  ...nitroRuntimeResolverNames,
  "@vite-hub/content/vite",
  "@vite-hub/sandbox/task/vite",
  "@vite-hub/workflow/vite",
  "vite-hub/agent-invocations",
])

function pluginResolveIdHandler(plugin: Plugin): HookHandler<NonNullable<Plugin["resolveId"]>> | undefined {
  if (typeof plugin.resolveId === "function") return plugin.resolveId
  return plugin.resolveId?.handler
}

function pluginLoadHandler(plugin: Plugin): HookHandler<NonNullable<Plugin["load"]>> | undefined {
  if (typeof plugin.load === "function") return plugin.load
  return plugin.load?.handler
}

function withHookFilter<Handler>(hook: unknown, handler: Handler): Handler | { filter: unknown, handler: Handler } {
  return isRecord(hook) && hook.filter !== undefined ? { filter: hook.filter, handler } : handler
}

export function nitroRuntimeResolver(plugin: Plugin, config: Record<string, unknown>, agentOptions: { root: string, serverDirs?: string[] }): { plugin: Plugin, originalHooks: Pick<Plugin, "resolveId" | "load" | "transform"> } | undefined {
  const resolveId = nitroRuntimeResolverNames.has(plugin.name) ? pluginResolveIdHandler(plugin) : undefined
  const load = nitroRuntimeResolverNames.has(plugin.name) ? pluginLoadHandler(plugin) : undefined
  const transformAgentDefinition = (plugin as Plugin & {
    vitehub?: { agent?: { transformAgentDefinition?: AgentDefinitionTransform } }
  }).vitehub?.agent?.transformAgentDefinition
  const serverTransform = !transformAgentDefinition && nitroServerTransformNames.has(plugin.name)
    ? typeof plugin.transform === "function" ? plugin.transform : plugin.transform?.handler
    : undefined
  if (!resolveId && !load && !transformAgentDefinition && !serverTransform) return

  const replayResolveId: HookHandler<NonNullable<Plugin["resolveId"]>> | undefined = resolveId && function (id, importer, options) {
    if (isCloudflareDevShim(id) && isRecord(config.alias) && typeof config.alias[id] === "string") return
    return resolveId.call(this, id, importer, { ...options, ssr: true })
  }
  const replayLoad: HookHandler<NonNullable<Plugin["load"]>> | undefined = load && function (id, options) {
    return load.call(this, id, { ...options, ssr: true })
  }
  const replayServerTransform: HookHandler<NonNullable<Plugin["transform"]>> | undefined = serverTransform && function (code, id, options) {
    return serverTransform.call(this, code, id, { moduleType: "js", ...options, ssr: true })
  }
  const replayAgentTransform = transformAgentDefinition && {
    filter: { id: /\.[cm]?[jt]s(?:[?#]|$)/i },
    handler(this: ThisParameterType<HookHandler<NonNullable<Plugin["transform"]>>> | undefined, code: string, id: string) {
      const resolver = typeof this?.resolve === "function" ? this : undefined
      return transformAgentDefinition(code, id, {
        ...agentOptions,
        ...(resolver ? { resolve: async (specifier: string, importer: string) => (await resolver.resolve(specifier, importer, { skipSelf: true }))?.id } : {}),
      })
    },
  }
  const originalHooks = {
    // SAFETY: the filter comes from the same hook of the replayed plugin, so it has that hook's filter type.
    ...(replayResolveId ? { resolveId: withHookFilter(plugin.resolveId, replayResolveId) as Plugin["resolveId"] } : {}),
    ...(replayLoad ? { load: withHookFilter(plugin.load, replayLoad) as Plugin["load"] } : {}),
    ...(replayServerTransform ? {
      // SAFETY: the filter belongs to the same transform hook of the replayed plugin.
      transform: withHookFilter(plugin.transform, replayServerTransform) as Plugin["transform"],
    } : {}),
    ...(replayAgentTransform ? { transform: replayAgentTransform as Plugin["transform"] } : {}),
  }
  return {
    originalHooks,
    plugin: {
      name: `vite-hub/nuxt-runtime-resolver:${plugin.name}`,
      ...originalHooks,
      ...(plugin.name === "@vite-hub/i18n/vite" && plugin.renderChunk ? { renderChunk: plugin.renderChunk } : {}),
    },
  }
}
