import { handleChannelReplayRequest } from "@vite-hub/agent/server/internal"
import { createExecutionContext, createRuntimeWaitUntilController } from "@vite-hub/runtime"

import { console } from "../../server.ts"
import { getConsoleAgentDefinition } from "./agents.ts"
import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { consoleRequestJSON, consoleRequestURL, setConsoleResponseHeaders } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import type { AgentRuntimeContext } from "@vite-hub/agent"

/** Items per request. The CLI continues with the returned cursor. */
const maximumReplayItemsPerRequest = 100

function replayError(message: string, status: number): Response {
  return Response.json({ message }, { headers: { "cache-control": "no-store" }, status })
}

function header(event: ConsoleRequestEvent, name: string): string | undefined {
  const raw = event.req?.headers?.get(name) ?? event.headers?.get(name) ?? event.node?.req?.headers?.[name]
  return (Array.isArray(raw) ? raw[0] : raw) ?? undefined
}

function memo() {
  const values = new Map<string, unknown>()
  return <T>(key: string, create: () => T): T => {
    if (!values.has(key)) values.set(key, create())
    // SAFETY: This closure stores and returns each value under the key from the same generic call.
    return values.get(key) as T
  }
}

/**
 * Replays Channel history for `vitehub channels replay --url`.
 * The default export checks Console access first. This handler also needs Console invocation to be enabled.
 */
async function channelReplayHandler(event: ConsoleRequestEvent): Promise<Response> {
  setConsoleResponseHeaders(event)
  const method = event.method ?? event.req?.method ?? event.node?.req?.method
  if (method !== "POST") return replayError("Method not allowed.", 405)
  // A JSON content type and a same-origin check keep browsers from sending cross-site replay requests.
  if (!header(event, "content-type")?.toLowerCase().startsWith("application/json")) return replayError("Channel replay requires application/json.", 415)
  const url = consoleRequestURL(event)
  const origin = header(event, "origin")
  if (origin && origin !== url.origin) return replayError("Channel replay origin is not allowed.", 403)
  let body: unknown
  try {
    body = await consoleRequestJSON(event)
  }
  catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 413) {
      return replayError("Channel replay request body is too large.", 413)
    }
    return replayError("Malformed Channel replay payload.", 400)
  }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Request JSON is untyped until this boundary validates its object shape.
  if (!body || typeof body !== "object" || Array.isArray(body) || !("agent" in body)) {
    return replayError("Channel replay requires an Agent name.", 400)
  }
  // SAFETY: the object guard above establishes a string-keyed JSON object.
  const replayBody = body as Record<string, unknown>
  const agentName = replayBody.agent
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The agent field is untyped request JSON until validated here.
  if (typeof agentName !== "string" || !agentName.trim()) return replayError("Channel replay requires an Agent name.", 400)
  const name = agentName
  const { agent: _, ...replay } = replayBody
  const agent = getConsoleAgentDefinition(name)
  if (!agent) return replayError("Channel replay is not available. Enable Console invocation for this Agent.", 404)
  const tasks = createRuntimeWaitUntilController({ forward: event.waitUntil })
  const context = createExecutionContext<AgentRuntimeContext>({
    agentIdentity: { name },
    capabilities: { console },
    memo: memo(),
    request: new Request(url, { method: "POST" }),
    runtime: "unknown" as const,
    runtimeConfig: {},
    waitUntil: tasks.waitUntil,
  })
  return await handleChannelReplayRequest(agent, replay, { maxLimit: maximumReplayItemsPerRequest, runtime: context })
}

const guardedHandler: ConsoleAccessRoute<typeof channelReplayHandler> = withConsoleAccess(channelReplayHandler)
export default guardedHandler
