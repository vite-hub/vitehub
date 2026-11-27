import { consoleRoutes } from "./routes.ts"

import type { ConsoleRoute } from "./request.ts"

const consoleHostedCommentsEntry: ConsoleRoute = consoleRoutes({ siteAccess: false, hostedComments: true })

export default consoleHostedCommentsEntry
