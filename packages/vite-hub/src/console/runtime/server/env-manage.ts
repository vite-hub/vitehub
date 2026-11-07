import { getStandardContext } from "@vite-hub/runtime/h3"

import { withConsoleAccess } from "./access.ts"
import { manageConsoleEnv } from "./env.ts"
import { consoleRoute } from "./request.ts"

import type { ConsoleRoute } from "./request.ts"

/** `POST <base>/_vitehub/env/manage`. It keeps the original headers and body for provider authentication and origin checks. */
const consoleEnvManageRoute: ConsoleRoute = consoleRoute(withConsoleAccess(event => manageConsoleEnv(getStandardContext(event).req), { section: "env", write: true }))
export default consoleEnvManageRoute
