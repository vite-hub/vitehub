import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation } from "@vite-hub/internal/operations"
import type { EnvInspectResult } from "./runtime/operations.ts"

const runtime = () => import("./runtime/operations.ts")

const inspect = defineOperation<Record<string, never>, EnvInspectResult>({
  // `vitehub env list` reads a local stage, and `vitehub env list --url` calls this operation on the running app.
  cli: { command: "list" },
  description: "Show the status of each Server Env value as the running app sees it. Values are never returned.",
  input: v.strictObject({}),
  kind: "read",
  name: "env.inspect",
  run: async (_input, context) => await (await runtime()).inspectEnvOperation(context),
  section: "env",
  user: false,
})

/** The `env.*` operations. The Console, the CLI, and agents run them on the signed `POST /_vitehub/rpc` endpoint. */
export const envOperations: readonly AnyOperation[] = [inspect]

export type { EnvInspectEntry, EnvInspectResult } from "./runtime/operations.ts"
