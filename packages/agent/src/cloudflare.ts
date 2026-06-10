import type { AgentInput, AgentRuntimeContext, CloudflareExportedHandlerFetchHandler } from "./types.ts"

import { runAgent, streamAgent } from "./index.ts"
import { toHttpErrorResponse } from "./http-error.ts"
import { readAgentRequestBody, toAgentFetchResponse } from "./http-response.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"
export { createCloudflareAgentState, ViteHubAgentStateAdapter } from "./state/providers/cloudflare.ts"
export type {
  CloudflareAgentStateOptions,
  ViteHubAgentStateDurableObjectNamespace,
  ViteHubAgentStateDurableObjectStub,
} from "./state/providers/cloudflare.ts"

type RouteAgentRequest = (request: Request, env: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Response | undefined> | Response | undefined

async function loadRouteAgentRequest(): Promise<RouteAgentRequest> {
  const mod = await import("agents")
  return mod.routeAgentRequest as RouteAgentRequest
}

export function defineCloudflareAgentHandler(
  agent: AgentInput<AgentRuntimeContext>,
): CloudflareExportedHandlerFetchHandler<Record<string, unknown>> {
  return async (request, env, executionContext) => {
    const context = createAgentRuntimeContext({
      cloudflare: {
        context: executionContext,
        env,
      },
      request,
      runtime: "cloudflare-agents" as const,
      waitUntil: task => executionContext.waitUntil?.(task),
    })
    try {
      const body = await readAgentRequestBody(request.clone())
      const stream = body.stream !== false
      const result = stream
        ? await streamAgent(agent, context, body)
        : await runAgent(agent, context, body)

      return toAgentFetchResponse(result, stream)
    }
    catch (error) {
      const response = toHttpErrorResponse(error)
      if (response) return response
      throw error
    }
  }
}

export function defineCloudflareAgentsRouter(
  options: Record<string, unknown> = {},
): CloudflareExportedHandlerFetchHandler<Record<string, unknown>> {
  return async (request, env) => {
    const routeAgentRequest = await loadRouteAgentRequest()
    const response = await routeAgentRequest(request, env, options)
    return response || new Response("Not found", { status: 404 })
  }
}
