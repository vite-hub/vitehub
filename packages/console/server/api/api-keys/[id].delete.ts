import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { revokeConsoleApiKey } from "../../../src/api-keys.ts"
import { consoleKeyCaller, consoleProblem } from "../../utils/console.ts"

const revoked = (done: boolean) => done ? new Response(null, { status: 204 }) : consoleProblem(404, "CONSOLE_API_KEY_NOT_FOUND", "There is no such API key.")

const withSession = withAuthorization(true, async (request: Request, { user }) => {
  const id = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "")
  return revoked(await revokeConsoleApiKey(useDatabase("default").db, user.id, id))
})

// Revoke an API key. The signed-in person revokes any of their keys. `vitehub logout` sends `DELETE
// /api/api-keys/current` with the key, which revokes that key.
export default {
  async fetch(request: Request): Promise<Response> {
    const caller = await consoleKeyCaller(request)
    if (caller === undefined) return withSession(request)
    if (caller instanceof Response) return caller
    if (!new URL(request.url).pathname.endsWith("/current")) return consoleProblem(403, "CONSOLE_API_KEY_FORBIDDEN", "An API key revokes only itself, with DELETE /api/api-keys/current. Revoke other keys in Settings.")
    return revoked(await revokeConsoleApiKey(useDatabase("default").db, caller.user.id, caller.key.id))
  },
}
