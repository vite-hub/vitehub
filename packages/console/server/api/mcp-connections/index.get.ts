import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { listConsoleMcpConnections } from "../../../src/mcp-connections.ts"
import { consoleJson } from "../../utils/console.ts"

export default {
  fetch: withAuthorization(true, async (_request: Request, { user }) => consoleJson({ connections: await listConsoleMcpConnections(useDatabase("default").db, user.id) })),
}
