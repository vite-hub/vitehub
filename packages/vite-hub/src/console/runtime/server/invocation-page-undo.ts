import { invocationPageChanges } from "@vite-hub/agent"

import { consoleHttpError } from "./http-error.ts"
import { getConsoleInvocations } from "./invocations.ts"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

import type { OperationContext } from "@vite-hub/internal/operations"

/** What an operator's undo did: the page put the value back, or why it could not. */
export interface ConsolePageUndoResult {
  ok: boolean
  change: string
  /** The changes the page could not put back: a person changed the field since, or it left the page. */
  notRestored: unknown[]
  /** Why the page could not be asked, such as `REALTIME_ROOM_EMPTY` when the person closed it. */
  code?: string
  error?: string
}

function actionError(statusCode: number, message: string): Error {
  return consoleHttpError(statusCode, viteHubErrorDiagnostics.VITE_HUB_R0046({ message }))
}

/**
 * Asks the person's open page to put back one change the Agent made. The page restores the value from its own record,
 * only while the field still shows the Agent's value, so this sends no value. The undo is appended to the Invocation. It
 * runs no Agent, so it needs write access to the Agents section, not Console invoke access.
 */
export async function undoConsolePageChange(input: { change: string, id: string }, context: OperationContext): Promise<ConsolePageUndoResult> {
  const invocations = getConsoleInvocations()
  const record = await invocations.get(input.id)
  if (!record) throw consoleHttpError(404, viteHubErrorDiagnostics.VITE_HUB_R0054({ message: "Invocation not found" }))
  const change = invocationPageChanges(record.observations).pageChanges.find(item => item.id === input.change)
  if (!change) throw actionError(404, `This Invocation has no page change ${JSON.stringify(input.change)}. Read the change ids with \`vitehub agent invocations show ${input.id}\`.`)
  const { agentRealtime } = await import("@vite-hub/realtime/agent")
  if (!agentRealtime.available()) throw actionError(409, "This app has no Realtime, so it cannot reach the page.")
  const [error, answer] = await agentRealtime.request("agent-pages", change.page, { method: "undo", input: { change: change.id } }, { timeout: 30_000, user: change.user === "anonymous" ? null : change.user })
  const page = answer && typeof answer === "object" ? answer : {}
  const restored = !error && "ok" in page && page.ok === true
  const notRestored = "notRestored" in page && Array.isArray(page.notRestored) ? page.notRestored : []
  const by = context.user?.id ?? context.actor?.id ?? context.surface
  await invocations.appendObservation(input.id, {
    attributes: { "page.change.id": change.id, "page.id": change.page, "page.undo.by": by, "page.undo.restored": restored },
    name: "agent.page.undo",
    type: "run",
  }, { id: `page-undo:${change.id}:${crypto.randomUUID()}` })
  return {
    ok: restored,
    change: change.id,
    notRestored,
    ...(error ? { code: error.code, error: error.why } : !restored && "error" in page && typeof page.error === "string" ? { error: page.error } : {}),
  }
}
