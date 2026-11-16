import { defineOperation } from "@vite-hub/internal/operations"
import * as v from "valibot"

import type { AnyOperation } from "@vite-hub/internal/operations"
import type { EnvInspectResult } from "./runtime/operations.ts"

// The runtime module imports the generated Server Env of the app, which only exists in the app server. The operation
// loads it when it runs, so the CLI and `vitehub inspect` can list it without it.
const runtime = () => import("./runtime/operations.ts")

const inspect = defineOperation<Record<string, never>, EnvInspectResult>({
  // `vitehub env inspect` reads a local stage. This command asks the running app, such as a deployment with `--url`.
  cli: { command: "status" },
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
