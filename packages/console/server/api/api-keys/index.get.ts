import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { listConsoleApiKeys } from "../../../src/api-keys.ts"
import { consoleJson } from "../../utils/console.ts"

export default {
  fetch: withAuthorization(true, async (_request: Request, { user }) => consoleJson({ apiKeys: await listConsoleApiKeys(useDatabase("default").db, user.id) })),
}
