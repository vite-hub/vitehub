import { toEventRequest } from "@vite-hub/internal/runtime/h3-v1-request"

import { withConsoleAccess } from "./access.ts"
import { withConsoleCors } from "./cors.ts"
import { manageConsoleEnv } from "./env.ts"

import type { H3Event } from "h3"

// Keep the original headers and body for provider authentication and origin checks. The Env bridge accepts only
// same-origin browser calls, so a listed origin gets the CORS headers to read its rejection.
const guardedHandler: (event: H3Event) => Promise<Response> = withConsoleCors(withConsoleAccess((event: H3Event) => manageConsoleEnv(toEventRequest(event)), { section: "env", write: true }))
export default guardedHandler
