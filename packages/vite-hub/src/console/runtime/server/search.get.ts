import { defineCollectionHandler } from "@vite-hub/source/server"

import { assertConsoleRequest } from "./request.ts"
import { consoleSearch } from "./search.ts"

import type { ConsoleRequestEvent } from "./request.ts"

const collectionHandler = defineCollectionHandler(consoleSearch)

export default async function consoleSearchHandler(event: ConsoleRequestEvent): Promise<unknown> {
  assertConsoleRequest(event)
  // SAFETY: Nitro supplies the H3 event consumed by the Collection handler; the console request contract
  // is the smaller request subset used for its read-only method guard.
  return await collectionHandler(event as never)
}
