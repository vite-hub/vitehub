import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { readConsoleAccount } from "../../src/accounts.ts"
import { consoleJson } from "../utils/console.ts"

export default {
  fetch: withAuthorization(true, async (_request: Request, { session, user }) => {
    const team: unknown = Reflect.get(session, "activeOrganizationId")
    return consoleJson(await readConsoleAccount(useDatabase("default").db, user, typeof team === "string" && team ? team : undefined))
  }),
}
