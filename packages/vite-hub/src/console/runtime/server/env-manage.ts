import { withConsoleAccess } from "./access.ts"
import { manageConsoleEnv } from "./env.ts"

import type { H3Event } from "h3"

// Keep the original headers and body for provider authentication and origin checks.
const guardedHandler: (event: H3Event) => Promise<Response> = withConsoleAccess((event: H3Event) => manageConsoleEnv(event.req))
export default guardedHandler
