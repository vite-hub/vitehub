import { handleChannelReplayRequest } from "@vite-hub/agent/server/internal"
import { createExecutionContext, createRuntimeWaitUntilController } from "@vite-hub/runtime"

import { agentConsole } from "../../server.ts"
import { getConsoleAgentCapabilities, getConsoleAgentDefinition } from "./agents.ts"
import { consoleAccessInvoker, readConsoleAccessUser, type ConsoleAccess } from "./access.ts"
import { consoleRequestError } from "./request.ts"

import type { AgentRuntimeContext } from "@vite-hub/agent"
import type { OperationContext } from "@vite-hub/internal/operations"

/** Items per call. The CLI continues with the returned cursor. */
const maximumReplayItemsPerRequest = 100

/** The input of `channels.replay`: the Agent, then the replay fields of `handleChannelReplayRequest()`. */
export interface ConsoleChannelReplayInput {
  agent: string
  channel: string
  cursor?: string
  describe?: boolean
  dryRun?: boolean
  force?: boolean
  label?: string
  limit?: number
  query?: Record<string, string | string[]>
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
 * Replays Channel history for `vitehub channels replay --url`, or describes its history query with `describe: true`.
 * The Agent must allow Console invocation, as the Console's own Agent invocations do.
 */
export async function replayConsoleChannel(
  { agent: name, ...replay }: ConsoleChannelReplayInput,
  context: Omit<OperationContext, "access"> & { access: ConsoleAccess },
): Promise<unknown> {
  const agent = getConsoleAgentDefinition(name)
  if (!agent) throw consoleRequestError(404, "Channel replay is not available. Enable Console invocation for this Agent.")
  const invoker = consoleAccessInvoker(readConsoleAccessUser(context.access))
  const tasks = createRuntimeWaitUntilController({ forward: context.waitUntil })
  const runtime = createExecutionContext<AgentRuntimeContext>({
    agentIdentity: { name },
    ...(invoker ? { invoker } : {}),
    capabilities: { ...await getConsoleAgentCapabilities(), console: agentConsole },
    memo: memo(),
    ...(context.request ? { request: context.request } : {}),
    runtime: "unknown" as const,
    runtimeConfig: {},
    waitUntil: tasks.waitUntil,
  })
  const response = await handleChannelReplayRequest(agent, replay, { ...(invoker ? { invoker } : {}), maxLimit: maximumReplayItemsPerRequest, runtime })
  const body: unknown = await response.json()
  if (response.ok) return body
  const message = Reflect.get(Object(body), "message")
  const code = Reflect.get(Object(body), "code")
  const error = consoleRequestError(response.status, typeof message === "string" ? message : "Channel replay failed.")
  // Agent failures keep their code, such as AGENT_R0931 for a Channel without history.
  throw typeof code === "string" ? Object.assign(error, { consoleCode: code }) : error
}
