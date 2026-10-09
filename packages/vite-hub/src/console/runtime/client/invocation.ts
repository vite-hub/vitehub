import * as v from "valibot"
import { watch } from "vue"

import { requestConsole } from "./request.ts"
import { encodeAgentRouteParam } from "../console-route.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

import type { AgentInvocationCancelResult } from "@vite-hub/agent"
import type { FileUIPart } from "ai"
import type { ConsoleAgentInvocationInput } from "../rpc.ts"

interface ConsoleInvocationTarget {
  agent: string
  base: string
  invokerProfileId?: string
}
const invocationResultSchema = v.object({ id: v.pipe(v.string(), v.nonEmpty()) })

/** Each selection change invalidates pending results, even when returning to the same Agent. */
export function useConsoleInvocationTarget(target: () => ConsoleInvocationTarget): () => { target: ConsoleInvocationTarget, isCurrent: () => boolean } {
  let generation = 0
  watch(() => {
    const { agent, base, invokerProfileId } = target()
    return [agent, base, invokerProfileId]
  }, () => { generation++ }, { flush: "sync" })
  return () => {
    const captured = generation
    return { target: { ...target() }, isCurrent: () => generation === captured }
  }
}

/** Capture the destination before uploads so switching Agents cannot redirect the input. */
export async function startConsoleAgentInvocation(
  { agent, base, invokerProfileId }: ConsoleInvocationTarget,
  message: { text: string, files?: readonly FileUIPart[] },
): Promise<{ agent: string, id: string }> {
  const body: ConsoleAgentInvocationInput = { prompt: message.text }
  if (invokerProfileId) body.invokerProfileId = invokerProfileId
  const files = [...message.files ?? []]
  if (files.length > 10) throw new Error("Use at most ten images.")
  if (files.length) {
    body.files = files.map(file => ({ url: file.url, filename: file.filename?.slice(0, 255) || "image" }))
  }
  const response = await requestConsole(`${base}/${encodeURIComponent(encodeAgentRouteParam(agent))}/invocations`, { body, method: "POST", query: { agentRoute: "encoded" } })
  const result = v.safeParse(invocationResultSchema, response)
  if (!result.success) throw viteHubErrorDiagnostics.VITE_HUB_R0102({ message: "The Agent invocation response did not include an id." })
  return { agent, id: result.output.id }
}

const cancelResultSchema = v.object({
  notEnforcedBy: v.optional(v.string()),
  delivery: v.optional(v.picklist(["local", "journal"])),
  outcome: v.picklist(["requested", "terminal"]),
  status: v.optional(v.picklist(["pending", "running", "cancelled", "completed", "failed"])),
})

/** Request an abort, including for a stale local execution with a terminal journal. */
export async function cancelConsoleInvocation(base: string, id: string): Promise<Pick<AgentInvocationCancelResult, "delivery" | "notEnforcedBy" | "status"> & { outcome: "requested" | "terminal" }> {
  const response = await requestConsole(`${base}/${encodeURIComponent(id)}`, { body: { action: "cancel" }, method: "POST" })
  const result = v.safeParse(cancelResultSchema, response)
  if (!result.success) throw viteHubErrorDiagnostics.VITE_HUB_R0102({ message: "The invocation cancel response was not valid." })
  return result.output
}

/** Delete one completed, failed, or cancelled invocation from the Console journal. */
export async function deleteConsoleInvocation(base: string, id: string): Promise<void> {
  await requestConsole(`${base}/${encodeURIComponent(id)}`, { body: { action: "delete" }, method: "POST" })
}
