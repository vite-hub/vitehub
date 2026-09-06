import { defineCollectionHandler } from "@vite-hub/source/server"

import { assertConsoleRequest } from "./request.ts"
import { consoleSearch } from "./search.ts"

import type { CollectionHandler } from "@vite-hub/source/server"
import type { ConsoleRequestEvent } from "./request.ts"

export const consoleSearchCollectionHandler: CollectionHandler = defineCollectionHandler(consoleSearch)

export default async function consoleSearchHandler(event: ConsoleRequestEvent): Promise<unknown> {
  assertConsoleRequest(event)
  // SAFETY: Nitro supplies this H3 event; ConsoleRequestEvent is its smaller read-only guard contract.
  return await consoleSearchCollectionHandler(event as never)
}
