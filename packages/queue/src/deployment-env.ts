import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import { postgresQueueUrlVariable } from "./config.ts"

import type { ResolvedQueueOptions } from "./types.ts"

const owners = ["queue"]

/**
 * The variables that Queue reads on the deployed host. The `postgres` provider reads `QUEUE_POSTGRES_URL`, which is
 * required unless the build found a Postgres Default Database to borrow. The `vercel` provider reads the optional
 * `QUEUE_REGION`. Cloudflare Queues and the `local` provider read none.
 */
export function queueDeploymentEnv(queue: false | ResolvedQueueOptions | undefined): DeploymentEnvEntry[] {
  if (!queue) return []
  if (queue.provider === "postgres") {
    return [{ names: [postgresQueueUrlVariable], required: !queue.database, secret: true, hasDefault: Boolean(queue.database), owners }]
  }
  if (queue.provider === "vercel") {
    return [{ names: ["QUEUE_REGION"], required: false, secret: false, hasDefault: false, owners }]
  }
  return []
}
