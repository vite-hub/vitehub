import type { ConsoleCaller, ConsoleCallerUser } from "@vite-hub/internal/console-signature"
import { operationConfirmationHeader, operationSurfaceHeader } from "@vite-hub/internal/operations"

import { isPasskeyEmail } from "./accounts.ts"

/** How the Console calls an app for a person: from the Console page, or from the ViteHub MCP. */
export interface ConsoleCallOptions {
  /**
   * `"mcp"` when the ViteHub MCP calls for the person. The app then applies its MCP rules: it refuses operations with
   * `mcp: false`, runs the others with the `mcp` surface, and refuses a destructive call that is not `confirmed`.
   */
  surface?: "mcp" | "cli"
  /** The person agreed to this destructive call. Only for the MCP and CLI surfaces. */
  confirmed?: boolean
  /** The app runs only operations that read, and refuses a write or destructive call. */
  readOnly?: boolean
}

/**
 * The person that the Console signs into each call to a project: the signed-in user, the team, and the role. The app's
 * `console.authorize` receives them with `via: "console"`.
 */
export function consoleCallerOf(caller: { user: ConsoleCallerUser, teamId: string, roles: readonly string[] }, options: ConsoleCallOptions = {}): ConsoleCaller {
  const role = presentationText(caller.roles.join(","))
  return {
    team: { id: caller.teamId, ...(role ? { role } : {}) },
    user: caller.user,
    via: "console",
    ...(options.surface ? { surface: options.surface, ...(options.confirmed ? { confirmed: true } : {}) } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
  }
}

export function consoleForwardCaller(request: Request, caller: Parameters<typeof consoleCallerOf>[0]): ConsoleCaller {
  return consoleCallerOf(caller, "key" in caller && request.headers.get(operationSurfaceHeader) === "cli"
    ? { surface: "cli", confirmed: request.headers.get(operationConfirmationHeader) === "confirmed" }
    : undefined)
}

/**
 * The signed fields of a person: the id, and the name and email when they have them and they fit the signed header. The
 * placeholder email of a passkey account is not an email, so it is left out.
 */
export function consoleCallerUser(user: { id: string, name?: unknown, email?: unknown, emailVerified?: unknown }): ConsoleCallerUser {
  const name = presentationText(user.name)
  const presented = presentationText(user.email)
  const email = presented && !isPasskeyEmail(presented) ? presented : undefined
  return { id: user.id, ...(name ? { name } : {}), ...(email ? { email, ...(user.emailVerified === true ? { emailVerified: true } : {}) } : {}) }
}

function presentationText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined
}
