import { defineCollectionHandler } from "@vite-hub/source/server"

import { consoleSearch } from "./search.ts"

import type { CollectionHandler } from "@vite-hub/source/server"

export const consoleSearchCollectionHandler: CollectionHandler = defineCollectionHandler(consoleSearch)
