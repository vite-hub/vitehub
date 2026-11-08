import { getStandardContext } from "@vite-hub/runtime/h3"

import { withConsoleAccess } from "./access.ts"
import { isConsoleCrossOriginBearerCall, withConsoleCors } from "./cors.ts"
import { manageConsoleEnv } from "./env.ts"
import { consoleRoute } from "./request.ts"

import type { ConsoleRoute } from "./request.ts"

/**
 * `POST <base>/_vitehub/env/manage`. It keeps the original headers and body for provider authentication and origin
 * checks. The Env bridge accepts a browser origin other than the app's own only when the Console access check accepted
 * a bearer call from `console.origins`.
 */
const consoleEnvManageRoute: ConsoleRoute = consoleRoute(withConsoleCors(withConsoleAccess((event, access) => {
  const request = getStandardContext(event).req
  const origin = request.headers.get("origin")
  return manageConsoleEnv(request, origin && isConsoleCrossOriginBearerCall(request, access) ? { allowedOrigin: origin } : {})
}, { section: "env", write: true })))
export default consoleEnvManageRoute
