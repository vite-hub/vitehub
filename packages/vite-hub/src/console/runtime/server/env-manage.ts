import { getStandardContext } from "@vite-hub/runtime/h3"

import { withConsoleAccess } from "./access.ts"
import { isConsoleCrossOriginBearerCall, withConsoleCors } from "./cors.ts"
import { manageConsoleEnv } from "./env.ts"

import type { H3Event } from "h3"

// Keep the original headers and body for provider authentication and origin checks. The Env bridge accepts a browser
// origin other than the app's own only when the Console access check accepted a bearer call from `console.origins`.
const guardedHandler: (event: H3Event) => Promise<Response> = withConsoleCors(withConsoleAccess((event: H3Event, access) => {
  const request = getStandardContext(event).req
  const origin = request.headers.get("origin")
  return manageConsoleEnv(request, origin && isConsoleCrossOriginBearerCall(request, access) ? { allowedOrigin: origin } : {})
}, { section: "env", write: true }))
export default guardedHandler
