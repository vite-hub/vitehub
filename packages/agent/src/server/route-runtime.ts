// The runtime context of the Agent routes and the declared webhook paths. The generated declared webhook middleware runs
// for every request, so this module must not import the routes module or `chat`.
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { createRuntimeContext as createHostRuntimeContext } from "@vite-hub/runtime"

import { isRuntimeObject, isRuntimeString } from "../internal/runtime-value.ts"
import { resolveAgentTriggers } from "../trigger-runtime.ts"

import type {
  AgentHostIdentity,
  AgentInput,
  AgentRunMetadata,
  AgentRuntimeContext,
  AgentRuntimeConfig,
  AgentRuntimeName,
  AgentWaitUntil,
  AgentWebhookRegistrationDefinition,
  ResolvedAgentRuntimeContext,
  ResolvedAgentTriggerDefinition,
} from "../types.ts"

export interface ViteAgentRouteRuntimeConfig extends AgentRuntimeConfig {
  agent?: unknown
}

export interface ViteAgentRouteRuntimeContext extends ResolvedAgentRuntimeContext<ViteAgentRouteRuntimeConfig> {
  request: Request
  runtime: AgentRuntimeName
  runtimeConfig: ViteAgentRouteRuntimeConfig
}

export interface AgentRouteRuntimeOptions {
  capabilities?: ViteAgentRouteRuntimeContext["capabilities"]
  agentIdentity?: AgentHostIdentity
  cloudflare?: ViteAgentRouteRuntimeContext["cloudflare"]
  runtime?: AgentRuntimeName
  /** Maximum inbound request bytes. Defaults to 1 MiB and cannot exceed 10 MiB. */
  maxBodyBytes?: number
  waitUntil?: AgentWaitUntil
}

export interface AgentWebhookRegistrationMatch {
  registration: AgentWebhookRegistrationDefinition
  trigger: ResolvedAgentTriggerDefinition<ViteAgentRouteRuntimeConfig>
}

const vercelFunctionsPackage = "@vercel/functions"

export function detectRuntime(): AgentRuntimeName {
  if ("Deno" in globalThis) return "deno"
  const runtimeProcess = globalThis.process
  const env = isRuntimeObject(runtimeProcess) ? runtimeProcess.env : undefined
  if (env?.VERCEL) return "vercel"
  return "unknown"
}

export function routeAgentIdentity(options: AgentRouteRuntimeOptions & { agentName?: string }): AgentHostIdentity | undefined {
  return options.agentIdentity || (options.agentName ? { name: options.agentName } : undefined)
}

export function createRuntimeContext(
  request: Request,
  run: AgentRunMetadata | undefined,
  waitUntil?: AgentWaitUntil,
  cloudflare?: ViteAgentRouteRuntimeContext["cloudflare"],
  runtimeOverride?: AgentRuntimeName,
  capabilities?: ViteAgentRouteRuntimeContext["capabilities"],
  agentIdentity?: AgentHostIdentity,
  runtimeContext?: AgentRuntimeContext,
): ViteAgentRouteRuntimeContext {
  const runtime = runtimeContext?.runtime ?? (cloudflare ? "cloudflare-agents" : runtimeOverride || detectRuntime())
  return createHostRuntimeContext({
    ...(capabilities ? { capabilities } : {}),
    ...(cloudflare ? { cloudflare } : {}),
    ...runtimeContext,
    ...(agentIdentity ? { agentIdentity } : {}),
    request: runtimeContext?.request ?? request,
    ...(run ? { run } : {}),
    runtime,
    runtimeConfig: runtimeContext?.runtimeConfig ?? {},
    ...(runtime === "vercel" && waitUntil ? { vercel: { waitUntil } } : {}),
    ...(waitUntil ? { waitUntil } : {}),
  })
}

export async function runWithRuntimeCloudflareEnv<T>(context: ViteAgentRouteRuntimeContext, callback: () => Promise<T>): Promise<T> {
  if (!context.cloudflare?.env) {
    return callback()
  }
  return await runWithActiveCloudflareEnv(context.cloudflare.env, callback)
}

export async function resolveRuntimeWaitUntil(waitUntil: AgentWaitUntil | undefined): Promise<AgentWaitUntil | undefined> {
  if (detectRuntime() !== "vercel") return waitUntil
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const vercel = (await import(/* @vite-ignore */ vercelFunctionsPackage).catch(() => undefined)) as { waitUntil?: AgentWaitUntil } | undefined
  return vercel?.waitUntil || waitUntil
}

export function normalizeWebhookPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

export function webhookRegistrationPaths(registration: AgentWebhookRegistrationDefinition): string[] {
  const paths = [registration.path, ...(Array.isArray(registration.aliases) ? registration.aliases : [])]
  return paths.filter(path => isRuntimeString(path)).map(normalizeWebhookPath)
}

export async function agentWebhookRegistrations(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
): Promise<AgentWebhookRegistrationMatch[]> {
  // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
  const triggers = await resolveAgentTriggers(agent as never, context as never)
  return Object.values(triggers).flatMap((trigger) =>
    (trigger.webhooks || []).map((registration) => ({
      registration,
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      trigger: trigger as ResolvedAgentTriggerDefinition<ViteAgentRouteRuntimeConfig>,
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    })),
  )
}

/**
 * Resolve the declared webhook paths of an Agent once and return a test for a request pathname. Declared paths come
 * from the Agent Definition, not from the request. A failed resolution is not kept, so the next call tries again.
 */
export function createDeclaredWebhookPathMatcher(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request, options?: AgentRouteRuntimeOptions & { agentName?: string }) => Promise<(pathname: string) => boolean> {
  let declaredPaths: Promise<Set<string>> | undefined
  const resolveDeclaredPaths = async (request: Request, handlerOptions: AgentRouteRuntimeOptions & { agentName?: string }) => {
    const context = createRuntimeContext(
      request,
      undefined,
      await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
      handlerOptions.cloudflare,
      handlerOptions.runtime,
      handlerOptions.capabilities,
      routeAgentIdentity(handlerOptions),
    )
    const registrations = await runWithRuntimeCloudflareEnv(context, () => agentWebhookRegistrations(agent, context))
    return new Set(registrations.flatMap(({ registration }) => webhookRegistrationPaths(registration)))
  }
  return async (request, handlerOptions = {}) => {
    declaredPaths ??= resolveDeclaredPaths(request, handlerOptions).catch((error: unknown) => {
      declaredPaths = undefined
      throw error
    })
    const paths = await declaredPaths
    return pathname => paths.has(normalizeWebhookPath(pathname))
  }
}
