import { HTTPError } from "h3"
import { isPromptFreeMcpWrite } from "@vite-hub/internal/operations"

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
  if (options.readOnly && code === "CONSOLE_ACCESS_DENIED" && message.endsWith("this caller may only read.")) {
    const next = isPromptFreeMcpWrite(operation) ? "Use run_operation." : "Explain the change and use run_destructive_operation with confirm: true after the user agrees."
    throw new HTTPError({ message: `${operation} changes data, and read_operation runs only reads and dry runs. ${next}`, status: 403 })
  }
  throw new HTTPError({ message: `The app answered ${result.status}${code ? ` ${code}` : ""}: ${message}${fix ? ` Fix: ${fix}` : ""}`, status: 400 })
}
