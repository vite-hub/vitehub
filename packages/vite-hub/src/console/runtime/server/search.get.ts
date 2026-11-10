import { defineCollectionHandler } from "@vite-hub/source/server"
import * as v from "valibot"

import { consoleRequest, withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest, consoleRequestError } from "./request.ts"
import { consoleSearch } from "./search.ts"

import type { CollectionHandler } from "@vite-hub/source/server"
import type { ConsoleRequestEvent } from "./request.ts"

export const consoleSearchCollectionHandler: CollectionHandler = defineCollectionHandler(consoleSearch)

const errorBodySchema = v.object({ message: v.string() })

async function consoleSearchHandler(event: ConsoleRequestEvent): Promise<unknown> {
  assertConsoleRequest(event)
  const response = await consoleSearchCollectionHandler.fetch(consoleRequest(event))
  if (response.ok) return await response.json()
  // The Collection route answers a bad query with `{ status, message }`. Console routes throw their own error.
  const body = v.safeParse(errorBodySchema, await response.json())
  throw consoleRequestError(response.status, body.success ? body.output.message : "Console search failed.")
}

const guardedHandler: ConsoleAccessRoute<typeof consoleSearchHandler> = withConsoleAccess(consoleSearchHandler, { section: "agents" })
export default guardedHandler
