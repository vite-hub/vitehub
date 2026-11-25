import { consoleRoutes } from "./routes.ts"

import type { ConsoleRoute } from "./request.ts"

const consoleSiteAccessEntry: ConsoleRoute = consoleRoutes({ siteAccess: true })

export default consoleSiteAccessEntry
