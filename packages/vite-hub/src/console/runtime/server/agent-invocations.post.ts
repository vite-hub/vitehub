import { agentInvocationId, startAgentInvocation } from "@vite-hub/agent"
import { createExecutionContext, createRuntimeWaitUntilController } from "@vite-hub/runtime"
import * as v from "valibot"

import { encodeAgentRouteParam } from "../console-route.ts"
import { console } from "../../server.ts"
import { consoleAgentInvokerProfiles, getConsoleAgentDefinition } from "./agents.ts"
import { assertConsoleRequest, consoleRequestJSON, consoleRequestURL, setConsoleResponseStatus } from "./request.ts"

import type { ConsoleRequestEvent } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

const allowedInputKeys = new Set(["prompt", "invokerProfileId"])
const recordSchema = v.record(v.string(), v.unknown())
const stringSchema = v.string()

function consoleError(statusCode: number, statusMessage: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0046({ message: statusMessage }), { statusCode, statusMessage })
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return
  const result = v.safeParse(recordSchema, value)
  return result.success ? result.output : undefined
}

function stringValue(value: unknown): string | undefined {
  const result = v.safeParse(stringSchema, value)
  return result.success ? result.output : undefined
}

function agentName(event: ConsoleRequestEvent): string {
  const value = event.context?.params?.agent?.trim()
  if (!value) throw consoleError(400, "Missing Agent name.")
  try {
    return decodeURIComponent(value)
  }
  catch {
    throw consoleError(400, "Invalid Agent name.")
  }
}

function memo() {
  const values = new Map<string, unknown>()
  return <T>(key: string, create: () => T): T => {
    if (!values.has(key)) values.set(key, create())
    // SAFETY: This closure stores and returns each value under the key from the same generic call.
    return values.get(key) as T
  }
}

async function waitForInvocation(controller: Awaited<ReturnType<typeof startAgentInvocation>>): Promise<void> {
  for (;;) {
    const result = await controller.inspect()
    if (result.outcome !== "available") return
    if (["cancelled", "completed", "failed"].includes(result.invocation.status)) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

interface ConsoleAgentInvocationResult {
  agent: string
  id: string
  url: string
}

const agentInvocationsHandler: (event: ConsoleRequestEvent) => Promise<ConsoleAgentInvocationResult> = async (event) => {
  assertConsoleRequest(event, ["POST"])
  const name = agentName(event)
  const agent = getConsoleAgentDefinition(name)
  if (!agent) throw consoleError(404, "Agent invocation is not available.")

  let body: Record<string, unknown> | undefined
  try {
    body = record(await consoleRequestJSON(event))
  }
  catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error
    throw consoleError(400, "Malformed Agent invocation payload.")
  }
  if (!body) throw consoleError(400, "Agent invocation payload must be an object.")
  const unknown = Object.keys(body).filter(key => !allowedInputKeys.has(key))
  if (unknown.length) throw consoleError(400, `Unsupported Agent invocation field: ${unknown[0]}.`)

  const prompt = stringValue(body.prompt)?.trim() ?? ""
  if (!prompt) throw consoleError(400, "Agent invocation requires a prompt.")
  const profileValue = body.invokerProfileId
  let profileId: string | undefined
  if (profileValue !== undefined) {
    profileId = stringValue(profileValue)?.trim()
    if (!profileId) throw consoleError(400, "Agent invocation profile must be a non-empty string.")
  }
  if (profileId && !consoleAgentInvokerProfiles(agent).some(profile => profile.id === profileId)) {
    throw consoleError(400, "Unknown Agent invocation profile.")
  }

  const tasks = createRuntimeWaitUntilController({ forward: event.waitUntil })
  const controller = await startAgentInvocation(agent, createExecutionContext({
    agentIdentity: { name },
    capabilities: { console },
    memo: memo(),
    request: new Request(consoleRequestURL(event), { method: "POST" }),
    runtime: "unknown" as const,
    runtimeConfig: {},
    waitUntil: tasks.waitUntil,
  }), {
    context: profileId ? { invokerProfileId: profileId } : {},
    prompt,
  })
  tasks.waitUntil(waitForInvocation(controller))
  const id = await agentInvocationId(controller.id, name)
  setConsoleResponseStatus(event, 202)
  return {
    agent: name,
    id,
    url: `/_vitehub/agents/${encodeURIComponent(encodeAgentRouteParam(name))}/invocations/${encodeURIComponent(id)}`,
  }
}

export default agentInvocationsHandler
