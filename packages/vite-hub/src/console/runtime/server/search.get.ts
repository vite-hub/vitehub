import { defineCollectionHandler } from "@vite-hub/source/server"

import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest } from "./request.ts"
import { consoleSearch } from "./search.ts"

import type { CollectionHandler } from "@vite-hub/source/server"
import type { ConsoleRequestEvent } from "./request.ts"

export const consoleSearchCollectionHandler: CollectionHandler = defineCollectionHandler(consoleSearch)

async function consoleSearchHandler(event: ConsoleRequestEvent): Promise<unknown> {
  assertConsoleRequest(event)
  // SAFETY: Nitro supplies this H3 event; ConsoleRequestEvent is its smaller read-only guard contract.
  return await consoleSearchCollectionHandler(event as never)
}

const guardedHandler: ConsoleAccessRoute<typeof consoleSearchHandler> = withConsoleAccess(consoleSearchHandler)
export default guardedHandler
