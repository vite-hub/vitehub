import { consoleAppSignIn } from "./access.ts"

import type { ConsoleRequestEvent } from "./request.ts"

/** Run before app Auth, which would reject a signed-out visit to its own sign-in page at `/_vitehub/sign-in`. */
export default function consoleSignInMiddleware(event: ConsoleRequestEvent): Promise<Response | undefined> {
  return consoleAppSignIn(event) ?? Promise.resolve(undefined)
}
