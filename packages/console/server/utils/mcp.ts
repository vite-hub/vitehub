import { HTTPError } from "h3"

import { callProjectOperation, consoleActiveTeam, consoleCallerUser, consoleTeamCaller, projectNotFound } from "./console.ts"

import type { McpToolCaller } from "vite-hub/mcp"
import type { ConsoleTeamCaller } from "./console.ts"

export interface McpTeamCaller extends ConsoleTeamCaller {
  team: { id: string, name: string, role: string }
}

export async function consoleToolError(response: Response): Promise<HTTPError> {
  const body: unknown = await response.json().catch(() => undefined)
  const code: unknown = body instanceof Object ? Reflect.get(body, "code") : undefined
  const message: unknown = body instanceof Object ? Reflect.get(body, "message") : undefined
  const text = typeof message === "string" && message ? message : `The Console answered ${response.status}.`
  return new HTTPError({ message: typeof code === "string" ? `${code}: ${text}` : text, status: response.status >= 400 && response.status < 500 ? response.status : 400 })
}

export async function mcpTeamCaller(caller: McpToolCaller | undefined): Promise<McpTeamCaller> {
  if (!caller) throw new HTTPError({ message: "This tool needs a Console account. Connect to /mcp/account and sign in.", status: 401 })
  const team = await consoleActiveTeam(caller.user.id)
  if (!team) throw new HTTPError({ message: "CONSOLE_TEAM_REQUIRED: You are not a member of a team. Open the Console to make one.", status: 403 })
  const member = await consoleTeamCaller(consoleCallerUser(caller.user), team.id)
  if (member instanceof Response) throw await consoleToolError(member)
  return { ...member, team: { ...team, role: member.roles.join(",") } }
}

export async function consoleToolAnswer(response: Response): Promise<unknown> {
  if (!response.ok) throw await consoleToolError(response)
  return response.status === 204 ? null : await response.json()
}

export async function projectOperation(caller: McpToolCaller | undefined, id: string, operation: string, input: unknown, options: { confirmed?: boolean, readOnly?: boolean } = {}): Promise<unknown> {
  const member = await mcpTeamCaller(caller)
  const result = await callProjectOperation(member, id, operation, input, { surface: "mcp", ...options })
  if (!result) throw await consoleToolError(projectNotFound())
  if (result.ok) return result.value ?? null
  const { code, fix, message } = result.error
  if (code === "INTERNAL_R0026") {
    throw new HTTPError({ message: `${operation} deletes or publishes data, so the app asks for confirmation. Tell the person what it changes, then call run_operation again with confirm: true.`, status: 409 })
  }
  if (options.readOnly && code === "CONSOLE_ACCESS_DENIED" && message.endsWith("this caller may only read.")) {
    throw new HTTPError({ message: `${operation} changes data, and read_operation runs only operations that read. Call run_operation.`, status: 403 })
  }
  throw new HTTPError({ message: `The app answered ${result.status}${code ? ` ${code}` : ""}: ${message}${fix ? ` Fix: ${fix}` : ""}`, status: 400 })
}
