import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import { realtimeNamespaceVariable, realtimePostgresUrlVariable } from "./bus.ts"

import type { RealtimeNodeAuthority } from "./bus.ts"

const owners = ["realtime"]

function entry(names: readonly string[], required: boolean, secret: boolean, hasDefault = false): DeploymentEnvEntry {
  return { names, required, secret, hasDefault, owners }
}

/**
 * The variables that Realtime reads on the deployed host. A Node server picks its bus at boot: `REDIS_URL`, then
 * `REALTIME_POSTGRES_URL`, then a Postgres Default Database, else memory. An explicit `redis` or `postgres` authority
 * requires its connection. `REALTIME_NAMESPACE` is optional. Durable Objects on Cloudflare and `memory` read none.
 */
export function realtimeDeploymentEnv(
  input: { authority: RealtimeNodeAuthority | "cloudflare" | "memory", postgresDatabase: boolean },
  context: DeploymentEnvContext,
): DeploymentEnvEntry[] {
  if (context.host !== "node" || input.authority === "cloudflare" || input.authority === "memory") return []
  const namespace = entry([realtimeNamespaceVariable], false, false, true)
  if (input.authority === "redis") return [entry(["REDIS_URL"], true, true), namespace]
  const postgres = entry([realtimePostgresUrlVariable], input.authority === "postgres" && !input.postgresDatabase, true, input.postgresDatabase)
  // An explicit `postgres` authority never reads `REDIS_URL`.
  return input.authority === "postgres" ? [postgres, namespace] : [entry(["REDIS_URL"], false, true), postgres, namespace]
}
