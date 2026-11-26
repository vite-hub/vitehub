import * as v from "valibot"

import { defineConsoleOperation, legacyEvent } from "../../console/runtime/server/operations.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"

const envGet = defineConsoleOperation({
  description: "Read the Server Env declarations. `env.inspect` reads the status of their values.",
  input: v.strictObject({}),
  kind: "read",
  name: "env.get",
  run: async (_input, context) => (await import("./env.get.ts")).default(legacyEvent("env", "GET", {}, context)),
  section: "env",
})

/** The Console operation of the Env section that `vite-hub` owns. `@vite-hub/env` contributes the others. */
export const envConsoleOperations: readonly AnyOperation[] = [
  envGet,
]
