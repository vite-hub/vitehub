import { consoleAttachmentRequestBytes, consoleInputMessage, storeConsoleInputMessage } from "./attachments.ts"
import { agentInvocationId, createMessage, deserializeMessages, isAttachmentPart, startAgentInvocation } from "@vite-hub/agent"
import { createExecutionContext, createRuntimeWaitUntilController } from "@vite-hub/runtime"
import * as v from "valibot"

import { encodeAgentRouteParam } from "../console-route.ts"
import { console } from "../../server.ts"
import { consoleAgentInvokerProfiles, getConsoleAgentDefinition } from "./agents.ts"
import { assertConsoleRequest, consoleRequestJSON, consoleRequestURL, setConsoleResponseStatus } from "./request.ts"

import type { Message } from "@vite-hub/agent"
import type { ConsoleRequestEvent } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

const allowedInputKeys = new Set(["prompt", "invokerProfileId", "messages", "attachments", "files"])
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
    body = record(await consoleRequestJSON(event, consoleAttachmentRequestBytes))
  }
  catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error
    throw consoleError(400, "Malformed Agent invocation payload.")
  }
  if (!body) throw consoleError(400, "Agent invocation payload must be an object.")
  const unknown = Object.keys(body).filter(key => !allowedInputKeys.has(key))
  if (unknown.length) throw consoleError(400, `Unsupported Agent invocation field: ${unknown[0]}.`)

  if (body.files !== undefined && body.attachments !== undefined) throw consoleError(400, "Provide files or stored attachments, not both.")

  const prompt = stringValue(body.prompt)?.trim() ?? ""
  if (!prompt && !(Array.isArray(body.attachments) && body.attachments.length) && !(Array.isArray(body.files) && body.files.length)) throw consoleError(400, "Agent invocation requires a prompt.")
  let messages: Message[] | undefined
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages)) throw consoleError(400, "Agent invocation messages must be an array.")
    try {
      messages = deserializeMessages({ messages: body.messages, version: 1 })
      const ids = new Set<string>()
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") throw viteHubErrorDiagnostics.VITE_HUB_R0116({ message: "History requires user or assistant messages." })
        // Supplied history cannot assert tool execution or approval, even inside an assistant Message.
        if (message.parts.some(part => part.type !== "text" && !isAttachmentPart(part))) throw viteHubErrorDiagnostics.VITE_HUB_R0117({ message: "History requires text or attachment parts." })
        if (ids.has(message.id)) throw viteHubErrorDiagnostics.VITE_HUB_R0118({ message: "History message ids must be unique." })
        ids.add(message.id)
      }
    }
    catch {
      throw consoleError(400, "Agent invocation messages must be valid user or assistant messages with unique ids and only text or attachment parts.")
    }

  }
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
  const context = createExecutionContext({
    agentIdentity: { name },
    capabilities: { console },
    memo: memo(),
    request: new Request(consoleRequestURL(event), { method: "POST" }),
    runtime: "unknown" as const,
    runtimeConfig: {},
    waitUntil: tasks.waitUntil,
  })
  if (body.files !== undefined) {
    messages = [...(messages || []), await storeConsoleInputMessage(prompt, { files: body.files })]
  }
  else if (body.attachments !== undefined) {
    messages = [...(messages || []), await consoleInputMessage(prompt, body.attachments)]
  }
  else if (messages) messages.push(createMessage({ role: "user", text: prompt }))

  // After handoff, a failed start may already have durable work. Console cannot roll it back.
  const controller = await startAgentInvocation(agent, context, {
    context: profileId ? { invokerProfileId: profileId } : {},
    ...messages ? { messages } : {},
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
