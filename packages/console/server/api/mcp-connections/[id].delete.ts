import { withAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { revokeConsoleMcpConnection } from "../../../src/mcp-connections.ts"
import { consoleProblem } from "../../utils/console.ts"

export default {
  fetch: withAuthorization(true, async (request: Request, { user }) => {
    const clientId = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "")
    if (await revokeConsoleMcpConnection(useDatabase("default").db, user.id, clientId)) return new Response(null, { status: 204 })
    return consoleProblem(404, "CONSOLE_MCP_CONNECTION_NOT_FOUND", "There is no such MCP connection.")
  }),
}
