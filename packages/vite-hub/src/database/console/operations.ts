import * as v from "valibot"

import { consoleRequestError } from "../../console/runtime/server/request.ts"

import { defineConsoleOperation, optionalCount, optionalText } from "../../console/runtime/server/operations.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"

const databasesBrowse = defineConsoleOperation({
  cli: { namespace: "database", command: "rows", positional: ["table"] },
  description: "Read the rows of a database table, one page at a time. Without a table it reads the tables only.",
  input: v.strictObject({
    database: optionalText,
    direction: v.optional(v.picklist(["asc", "desc"])),
    limit: optionalCount,
    offset: optionalCount,
    search: optionalText,
    sort: optionalText,
    table: optionalText,
  }),
  kind: "read",
  name: "databases.browse",
  run: async (input, context) => {
    const result = await (await import("./database.get.ts")).browseConsoleDatabase(input)
    if (input.table && context.surface !== "console" && result.table !== input.table) {
      throw consoleRequestError(404, `The database has no table "${input.table}".`)
    }
    return result
  },
  section: "databases",
})

const databasesTables = defineConsoleOperation({
  cli: { namespace: "database", command: "tables" },
  description: "List the tables of a database with their columns and relationships.",
  input: v.strictObject({ database: optionalText }),
  kind: "read",
  name: "databases.tables",
  run: async input => {
    const { database, databases, relationships, tables } = await (await import("./database.get.ts")).browseConsoleDatabase(input)
    return { database, databases, relationships, tables }
  },
  section: "databases",
})

/** The Console operations of the Databases section. The Console registers them only when the app has a Database. */
export const databaseConsoleOperations: readonly AnyOperation[] = [
  databasesBrowse,
  databasesTables,
]
