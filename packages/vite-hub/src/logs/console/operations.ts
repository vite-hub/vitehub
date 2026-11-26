import * as v from "valibot"

import { defineConsoleOperation, legacyEvent, optionalCount, optionalText } from "../../console/runtime/server/operations.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"

const logsList = defineConsoleOperation({
  description: "Read structured events from the connected log source.",
  input: v.strictObject({ text: optionalText, level: v.optional(v.picklist(["debug", "info", "warn", "error"])), service: optionalText, cursor: optionalText, limit: optionalCount }),
  kind: "read",
  name: "logs.list",
  run: async (input, context) => (await import("./logs.get.ts")).readConsoleLogs(legacyEvent("logs", "GET", { query: input }, context)),
  section: "logs",
})

/** The Console operation of the Logs section. The Console registers it only when the app has Logs. */
export const logsConsoleOperations: readonly AnyOperation[] = [
  logsList,
]
