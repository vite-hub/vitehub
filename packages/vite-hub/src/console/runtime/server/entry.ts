import { consoleRoutes } from "./routes.ts"

import type { ConsoleRoute } from "./request.ts"

const consoleEntry: ConsoleRoute = consoleRoutes({ siteAccess: false })

export default consoleEntry
