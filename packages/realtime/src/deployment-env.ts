import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import { realtimeNamespaceVariable, realtimePostgresUrlVariable } from "./bus.ts"

import type { RealtimeNodeDriver } from "./bus.ts"

const owners = ["realtime"]

function entry(names: readonly string[], required: boolean, secret: boolean, hasDefault = false): DeploymentEnvEntry {
  return { names, required, secret, hasDefault, owners }
}

/**
 * The variables that Realtime reads on the deployed host. A Node server picks its bus at boot: `REDIS_URL` or a Redis
 * `KV_URL`, then `REALTIME_POSTGRES_URL`, then a Postgres Default Database, else memory. A Vercel instance needs one of
 * them, and has no memory fallback. An explicit `redis` or `postgres` driver requires its connection.
 * `REALTIME_NAMESPACE` is optional. Durable Objects on Cloudflare and `memory` read none.
 */
export function realtimeDeploymentEnv(
  input: { driver: RealtimeNodeDriver | "cloudflare" | "memory", postgresDatabase: boolean },
  context: DeploymentEnvContext,
): DeploymentEnvEntry[] {
  if ((context.host !== "node" && context.host !== "vercel") || input.driver === "cloudflare" || input.driver === "memory") return []
  const namespace = entry([realtimeNamespaceVariable], false, false, true)
  const redisNames = ["REDIS_URL", "KV_URL"]
  if (input.driver === "redis") return [entry(redisNames, true, true), namespace]
  const postgres = entry([realtimePostgresUrlVariable], input.driver === "postgres" && !input.postgresDatabase, true, input.postgresDatabase)
  if (input.driver === "postgres") return [postgres, namespace]
  if (context.host === "vercel") return [entry([...redisNames, realtimePostgresUrlVariable], !input.postgresDatabase, true, input.postgresDatabase), namespace]
  return [entry(redisNames, false, true), postgres, namespace]
}
