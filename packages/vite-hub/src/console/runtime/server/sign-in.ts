import { consoleAppSignIn, consoleSignInRedirect } from "./access.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/** Run before app Auth so a signed-out page visit can reach the configured sign-in page. */
export default function consoleSignInMiddleware(event: ConsoleRequestEvent): Promise<Response | undefined> {
  return consoleAppSignIn(event) ?? consoleSignInRedirect(event)
}
