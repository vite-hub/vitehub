import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import { realtimeNamespaceVariable, realtimePostgresUrlVariable } from "./bus.ts"

import type { RealtimeNodeDriver } from "./bus.ts"

const owners = ["realtime"]

function entry(names: readonly string[], required: boolean, secret: boolean, hasDefault = false): DeploymentEnvEntry {
  return { names, required, secret, hasDefault, owners }
}

/**
 * The variables that Realtime reads on the deployed host. A Node server picks its bus at boot: `REDIS_URL`, then
 * `REALTIME_POSTGRES_URL`, then a Postgres Default Database, else memory. An explicit `redis` or `postgres` driver
 * requires its connection. `REALTIME_NAMESPACE` is optional. Durable Objects on Cloudflare and `memory` read none.
 */
export function realtimeDeploymentEnv(
  input: { driver: RealtimeNodeDriver | "cloudflare" | "memory", postgresDatabase: boolean },
  context: DeploymentEnvContext,
): DeploymentEnvEntry[] {
  if (context.host !== "node" || input.driver === "cloudflare" || input.driver === "memory") return []
  const namespace = entry([realtimeNamespaceVariable], false, false, true)
  if (input.driver === "redis") return [entry(["REDIS_URL"], true, true), namespace]
  const postgres = entry([realtimePostgresUrlVariable], input.driver === "postgres" && !input.postgresDatabase, true, input.postgresDatabase)
  return input.driver === "postgres" ? [postgres, namespace] : [entry(["REDIS_URL"], false, true), postgres, namespace]
}
