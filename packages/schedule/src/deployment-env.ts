import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

/**
 * The variables that Schedules read on the deployed host. The Vercel cron handler checks `CRON_SECRET` when it is set,
 * so it is optional. Cloudflare cron triggers and the Process Runtime read none.
 */
export function scheduleDeploymentEnv(definitions: number, context: DeploymentEnvContext): DeploymentEnvEntry[] {
  if (!definitions || context.host !== "vercel") return []
  return [{ names: ["CRON_SECRET"], required: false, secret: true, hasDefault: false, owners: ["schedule"] }]
}
