import * as v from "valibot"
import { handleChannelReplayRequest } from "@vite-hub/agent/server/internal"
import { createExecutionContext, createRuntimeWaitUntilController } from "@vite-hub/runtime"

import { console } from "../../server.ts"
import { getConsoleAgentDefinition } from "./agents.ts"
import { consoleRequestJSON, consoleRequestURL, setConsoleResponseHeaders } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/** Items per request. The CLI continues with the returned cursor. */
const maximumReplayItemsPerRequest = 100
const replayRequestSchema = v.looseObject({ agent: v.pipe(v.string(), v.check(value => value.trim().length > 0)) })

function replayError(message: string, status: number): Response {
  return Response.json({ message }, { headers: { "cache-control": "no-store" }, status })
}

function header(event: ConsoleRequestEvent, name: string): string | undefined {
  const value = event.req?.headers?.get(name) ?? event.headers?.get(name) ?? event.node?.req?.headers?.[name]
  return Array.isArray(value) ? value[0] : value ?? undefined
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
 * Console access protects `/_vitehub/**`; this handler also needs Console invocation to be enabled.
 */
export default async function channelReplayHandler(event: ConsoleRequestEvent): Promise<Response> {
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
  catch {
    return replayError("Malformed Channel replay payload.", 400)
  }
  const parsed = v.safeParse(replayRequestSchema, body)
  if (!parsed.success) return replayError("Channel replay requires an Agent name.", 400)
  const { agent: name, ...replay } = parsed.output
  const agent = getConsoleAgentDefinition(name)
  if (!agent) return replayError("Channel replay is not available. Enable Console invocation for this Agent.", 404)
  const tasks = createRuntimeWaitUntilController({ forward: event.waitUntil })
  const context = createExecutionContext({
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
