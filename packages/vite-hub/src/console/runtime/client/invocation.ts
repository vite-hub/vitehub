import * as v from "valibot"

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
    body.attachments = []
    for (const file of files) {
      const uploaded = await requestConsole(`${base.replace(/\/agents$/, "")}/attachments`, { method: "POST", body: file })
      body.attachments.push({ id: v.parse(invocationResultSchema, uploaded).id, name: file.filename?.slice(0, 255) || "image" })
    }
  }
  const response = await requestConsole(`${base}/${encodeURIComponent(agent)}/invocations`, { body, method: "POST" })
  const result = v.safeParse(invocationResultSchema, response)
  if (!result.success) throw viteHubErrorDiagnostics.VITE_HUB_R0102({ message: "The Agent invocation response did not include an id." })
  return { agent, id: result.output.id }
}
