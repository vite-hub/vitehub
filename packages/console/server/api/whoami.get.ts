import { consoleJson, consoleKeyCaller, consoleProblem } from "../utils/console.ts"

// Who an API key acts for: `vitehub whoami` calls it with `Authorization: Bearer vhk_...`. It never answers the key.
export default {
  async fetch(request: Request): Promise<Response> {
    const caller = await consoleKeyCaller(request)
    if (caller === undefined) return consoleProblem(401, "CONSOLE_API_KEY_REQUIRED", "Send an API key: `Authorization: Bearer vhk_...`. Run `vitehub login` to get one.")
    if (caller instanceof Response) return caller
    return consoleJson({ key: caller.key, projectIds: caller.projectIds ?? null, roles: caller.roles, team: caller.team, user: caller.user })
  },
}
