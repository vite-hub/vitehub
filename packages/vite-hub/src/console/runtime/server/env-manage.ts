import type { EventHandler } from "h3"
import { fromWebHandler } from "h3"
import { manageConsoleEnv } from "./env.ts"

// Keep the original headers and body for provider authentication and origin checks.
const handler: EventHandler = fromWebHandler(manageConsoleEnv)
export default handler
