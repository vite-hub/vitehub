import type { DeploymentEnvContext, DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

/**
 * The variables that Schedules read on the deployed host. The Vercel cron handler refuses every request until
 * `CRON_SECRET` is set, so it is required. Cloudflare cron triggers and the Process Runtime read none.
 */
export function scheduleDeploymentEnv(definitions: number, context: DeploymentEnvContext): DeploymentEnvEntry[] {
  if (!definitions || context.host !== "vercel") return []
  return [{ names: ["CRON_SECRET"], required: true, secret: true, hasDefault: false, owners: ["schedule"] }]
}
