import { getStandardContext } from "@vite-hub/runtime/h3"

import { withConsoleAccess } from "./access.ts"
import { manageConsoleEnv } from "./env.ts"

import type { H3Event } from "h3"

// Keep the original headers and body for provider authentication and origin checks.
const guardedHandler: (event: H3Event) => Promise<Response> = withConsoleAccess((event: H3Event) => manageConsoleEnv(getStandardContext(event).req), { section: "env", write: true })
export default guardedHandler
