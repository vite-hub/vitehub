import type { AuthAuthorization } from "@vite-hub/auth"
import type { ConsoleCaller } from "@vite-hub/internal/console-signature"

/** The account identity that the Console signs into each call to a project. */
export function consoleCallerOf(caller: { authorization: Pick<AuthAuthorization, "user">, teamId: string, roles: readonly string[] }): ConsoleCaller {
  const { user } = caller.authorization
  const name = presentationText(Reflect.get(user, "name"))
  const email = presentationText(Reflect.get(user, "email"))
  const role = presentationText(caller.roles.join(","))
  return {
    team: { id: caller.teamId, ...(role ? { role } : {}) },
    user: { id: user.id, ...(name ? { name } : {}), ...(email ? { email } : {}) },
    via: "console",
  }
}

/** Optional presentation fields must fit decodeConsoleCaller; required identity fields stay unchanged. */
function presentationText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined
}
