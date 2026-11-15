import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"

import type { ResolvedAuthViteConfig } from "./types.ts"

const owners = ["auth"]

// `admins.ts` and `admin-claim-code.ts` own these names. They load Better Auth, so the Vite plugin does not import them.

/**
 * The variables that Auth reads on the deployed host. Better Auth signs with the first Better Auth secret that is
 * set, else with the secret derived from `VITEHUB_SECRET`. `VITEHUB_ADMINS` and `VITEHUB_ADMIN_CLAIM` are optional.
 */
export function authDeploymentEnv(config: ResolvedAuthViteConfig | undefined): DeploymentEnvEntry[] {
  if (!config) return []
  return [
    { names: ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "AUTH_SECRET", "VITEHUB_SECRET"], required: true, secret: true, hasDefault: false, owners },
    { names: ["VITEHUB_ADMINS"], required: false, secret: false, hasDefault: false, owners },
    { names: ["VITEHUB_ADMIN_CLAIM"], required: false, secret: true, hasDefault: false, owners },
  ]
}
