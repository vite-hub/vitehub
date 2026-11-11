import { HTTPError } from "h3"

import { callProjectOperation, consoleActiveTeam, consoleTeamCaller, projectNotFound } from "./console.ts"

import type { McpToolCaller } from "vite-hub/mcp"
import type { ConsoleTeamCaller } from "./console.ts"

/** The caller of an account tool, with the team that the tools act on. */
export interface McpTeamCaller extends ConsoleTeamCaller {
  team: { id: string, name: string, role: string }
}

/**
 * A failed Console answer as a tool error: `CODE: message`. The Agent reads it, so it says what to change. Each tool
 * keeps the status and the rule of the Console HTTP route that it shares code with.
 */
export async function consoleToolError(response: Response): Promise<HTTPError> {
  const body: unknown = await response.json().catch(() => undefined)
  const code: unknown = body instanceof Object ? Reflect.get(body, "code") : undefined
  const message: unknown = body instanceof Object ? Reflect.get(body, "message") : undefined
  const text = typeof message === "string" && message ? message : `The Console answered ${response.status}.`
  // A 5xx tool error is hidden from the Agent, so only a 4xx keeps its text.
  return new HTTPError({ message: typeof code === "string" ? `${code}: ${text}` : text, status: response.status >= 400 && response.status < 500 ? response.status : 400 })
}

/**
 * The signed-in person of `/mcp/account` on the team that they opened last in the Console. The role in that team
 * decides what they may do, as in the Console.
 */
export async function mcpTeamCaller(caller: McpToolCaller | undefined): Promise<McpTeamCaller> {
  if (!caller) throw new HTTPError({ message: "This tool needs a Console account. Connect to /mcp/account and sign in.", status: 401 })
  const team = await consoleActiveTeam(caller.user.id)
  if (!team) throw new HTTPError({ message: "CONSOLE_TEAM_REQUIRED: You are not a member of a team. Open the Console to make one.", status: 403 })
  const member = await consoleTeamCaller(caller.user.id, team.id)
  if (member instanceof Response) throw await consoleToolError(member)
  return { ...member, team: { ...team, role: member.roles.join(",") } }
}

/** The answer of a Console helper as tool data, or the tool error of a failed answer. */
export async function consoleToolAnswer(response: Response): Promise<unknown> {
  if (!response.ok) throw await consoleToolError(response)
  return response.status === 204 ? null : await response.json()
}

/**
 * The confirmation rule of an app's Operations endpoint (`@vite-hub/internal/operations`): a call from the `cli`
 * surface with `x-vitehub-confirmation: required` gets `409` `INTERNAL_R0026` for a destructive call, and runs with
 * `confirmed`. The app decides which calls are destructive, including calls that only some inputs make destructive.
 */
const confirmationHeaders = (confirmed: boolean) => ({ "x-vitehub-confirmation": confirmed ? "confirmed" : "required", "x-vitehub-surface": "cli" })

function field(body: unknown, name: string): string | undefined {
  const value: unknown = body instanceof Object ? Reflect.get(body, name) : undefined
  return typeof value === "string" && value ? value : undefined
}

/**
 * Run one operation of a team's app through the forward, with the token of the link. The Agent's access token never
 * reaches the app. The app checks the operation, its input, and its confirmation rule; `confirmed` is the `confirm`
 * input of the Agent.
 */
export async function projectOperation(caller: McpToolCaller | undefined, id: string, operation: string, input: unknown, confirmed = false): Promise<unknown> {
  const member = await mcpTeamCaller(caller)
  const response = await callProjectOperation(member, id, operation, input, confirmationHeaders(confirmed))
  if (!response) throw await consoleToolError(projectNotFound())
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok && body instanceof Object && Reflect.get(body, "ok") === true) return Reflect.get(body, "value") ?? null
  const code = field(body, "code")
  if (code === "INTERNAL_R0026") {
    throw new HTTPError({ message: `${operation} deletes or publishes data, so the app asks for confirmation. Tell the person what it changes, then call run_operation again with confirm: true.`, status: 409 })
  }
  const fix = field(body, "fix")
  const message = field(body, "message") ?? "The app sent no message."
  // The app already hides its server errors, so its message is safe to show. A 4xx keeps the text for the Agent.
  throw new HTTPError({ message: `The app answered ${response.status}${code ? ` ${code}` : ""}: ${message}${fix ? ` Fix: ${fix}` : ""}`, status: 400 })
}
