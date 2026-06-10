import { waitUntil as vercelWaitUntil } from "@vercel/functions"

import { runAgent, streamAgent } from "./index.ts"
import { toHttpErrorResponse } from "./http-error.ts"
import { readAgentRequestBody, toAgentFetchResponse } from "./http-response.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"

import type { AgentInput, AgentRuntimeContext, AgentWaitUntil } from "./types.ts"

export function defineVercelAgentHandler(
  agent: AgentInput<AgentRuntimeContext>,
  options: { waitUntil?: AgentWaitUntil } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const waitUntil = options.waitUntil || vercelWaitUntil
    const context = createAgentRuntimeContext({
      request,
      runtime: "vercel" as const,
      vercel: { waitUntil },
      waitUntil,
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
