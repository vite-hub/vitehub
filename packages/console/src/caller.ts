import type { ConsoleCaller, ConsoleCallerUser } from "@vite-hub/internal/console-signature"

/** How the Console calls an app for a person: from the Console page, or from the ViteHub MCP. */
export interface ConsoleCallOptions {
  /**
   * `"mcp"` when the ViteHub MCP calls for the person. The app then applies its MCP rules: it refuses operations with
   * `mcp: false`, runs the others with the `mcp` surface, and refuses a destructive call that is not `confirmed`.
   */
  surface?: "mcp"
  /** The person agreed to this destructive call. Only for `surface: "mcp"`. */
  confirmed?: boolean
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
  }
}

/** The signed fields of a person: the id, and the name and email when they have them and they fit the signed header. */
export function consoleCallerUser(user: { id: string, name?: unknown, email?: unknown }): ConsoleCallerUser {
  const name = presentationText(user.name)
  const email = presentationText(user.email)
  return { id: user.id, ...(name ? { name } : {}), ...(email ? { email } : {}) }
}

/** Optional presentation fields must fit `decodeConsoleCaller()`; the required identity fields stay unchanged. */
function presentationText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined
}
