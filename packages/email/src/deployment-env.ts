import { describeServerEnv } from "@vite-hub/env/server"

import type { EnvRuntimeRegistry } from "@vite-hub/env"
import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

/** The variables of the provider options in `server/email.ts`, such as `RESEND_API_KEY`. Literal options read none. */
export function emailDeploymentEnv(options: EnvRuntimeRegistry | undefined): DeploymentEnvEntry[] {
  if (!options) return []
  return describeServerEnv(options).entries.flatMap(entry => entry.source === "env" && entry.names
    ? [{ names: entry.names, required: entry.required, secret: entry.secret, hasDefault: entry.hasDefault, owners: ["email"] }]
    : [])
}
