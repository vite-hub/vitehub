import { agentInvocationId, startAgentInvocation } from "@vite-hub/agent"
import { createExecutionContext, createRuntimeWaitUntilController } from "@vite-hub/runtime"

import { encodeAgentRouteParam } from "../console-route.ts"
import { console } from "../../server.ts"
import { consoleAgentInvokerProfiles, getConsoleAgentDefinition } from "./agents.ts"
import { assertConsoleRequest, consoleRequestJSON, consoleRequestURL, setConsoleResponseStatus } from "./request.ts"

import type { AgentInput } from "@vite-hub/agent"
import type { ConsoleRequestEvent } from "./request.ts"

const allowedInputKeys = new Set(["prompt", "invokerProfileId"])

function consoleError(statusCode: number, statusMessage: string): Error {
  return Object.assign(new Error(statusMessage), { statusCode, statusMessage })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
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

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (!prompt) throw consoleError(400, "Agent invocation requires a prompt.")
  const profileValue = body.invokerProfileId
  if (profileValue !== undefined && (typeof profileValue !== "string" || !profileValue.trim())) {
    throw consoleError(400, "Agent invocation profile must be a non-empty string.")
  }
  const profileId = typeof profileValue === "string" ? profileValue.trim() : undefined
  if (profileId && !consoleAgentInvokerProfiles(agent).some(profile => profile.id === profileId)) {
    throw consoleError(400, "Unknown Agent invocation profile.")
  }

  const tasks = createRuntimeWaitUntilController({ forward: event.waitUntil })
  // SAFETY: Console stores only discovered Agent Definition module exports at this boundary.
  const controller = await startAgentInvocation(agent as unknown as AgentInput, createExecutionContext({
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
