import { aiGatewayEnv } from "@vite-hub/gateways"

import { readBuiltInEnv } from "./builtin-env.ts"

import type { BuiltInEnvContext } from "./builtin-env.ts"

/**
 * Server Env read by gateway presets, keyed by preset name and then by the `env.server.<preset>.<field>` path.
 * ViteHub finds the presets in Agent files and declares these values in Server Env, so the Console shows them
 * and Env providers can supply them. They stay optional: a missing value fails only the request that needs it.
 */
export const builtInGatewayEnv = aiGatewayEnv

/** Read one gateway preset value from Server Env, or from its host variables without hubEnv(). */
export async function gatewayEnvValue(gateway: string, field: string, context: BuiltInEnvContext): Promise<unknown> {
  const fields: Readonly<Record<string, Readonly<Record<string, { names: readonly [string, ...string[]], secret?: true }>>>> = builtInGatewayEnv
  return (await readBuiltInEnv(gateway, fields[gateway] ?? {}, [field], context))[field]
}
