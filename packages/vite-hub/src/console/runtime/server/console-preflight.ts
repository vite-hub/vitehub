import { answerConsolePreflight } from "./cors.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/** Route-less Nitro middleware. It answers CORS preflights to Console data routes before app middleware and app Auth. */
const consolePreflightHandler = (event: ConsoleRequestEvent): Response | undefined => answerConsolePreflight(event)

export default consolePreflightHandler
