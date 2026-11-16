import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { readConsoleAccount } from "../../src/accounts.ts"
import { consoleJson } from "../utils/console.ts"

// The signed-in person, their teams, and the projects of the session's team, with one session check. The page HTML
// starts this read (src/page.ts), so it runs while the page code loads. Signed out, it answers `401` with the code
// `SIGNED_OUT`. The guard sends the cookies of the session check, so Better Auth renews an active session here, as its
// own `get-session` route does.
export default {
  fetch: withAuthorization(true, async (_request: Request, { session, user }) => {
    const team: unknown = Reflect.get(session, "activeOrganizationId")
    return consoleJson(await readConsoleAccount(useDatabase("default").db, user, typeof team === "string" && team ? team : undefined))
  }),
}
