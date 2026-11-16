import { useAuth } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { readConsoleAccount } from "../../src/accounts.ts"
import { consoleJson } from "../utils/console.ts"

// The signed-in person, their teams, and the projects of the session's team, with one session check. The page HTML
// starts this read (src/page.ts), so it runs while the page code loads. Signed out, it answers `401`.
export default {
  async fetch(request: Request): Promise<Response> {
    // `returnHeaders` keeps the cookies of the session check. Better Auth renews an active session there, as its own
    // `get-session` route does, so the browser session does not end at its first expiry.
    const { headers, response: found } = await useAuth(request).api.getSession({ headers: request.headers, returnHeaders: true })
    let response: Response
    if (!found) {
      response = consoleJson({ status: 401, statusText: "Unauthorized", message: "Unauthorized.", data: { code: "SIGNED_OUT" } }, 401)
    }
    else {
      const team: unknown = Reflect.get(found.session, "activeOrganizationId")
      response = consoleJson(await readConsoleAccount(useDatabase("default").db, found.user, typeof team === "string" && team ? team : undefined))
    }
    for (const cookie of headers.getSetCookie()) response.headers.append("set-cookie", cookie)
    return response
  },
}
