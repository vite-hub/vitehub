import * as v from "valibot"
import { watch } from "vue"

import { requestConsole } from "./request.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

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
  const response = await requestConsole(`${base}/${encodeURIComponent(agent)}/invocations`, { body, method: "POST" })
  const result = v.safeParse(invocationResultSchema, response)
  if (!result.success) throw viteHubErrorDiagnostics.VITE_HUB_R0102({ message: "The Agent invocation response did not include an id." })
  return { agent, id: result.output.id }
}
