import { readBuiltInEnv } from "./builtin-env.ts"

import type { BuiltInEnvContext, BuiltInEnvField } from "./builtin-env.ts"

/**
 * Server Env read by gateway presets, keyed by preset name and then by the `env.server.<preset>.<field>` path.
 * ViteHub finds the presets in Agent files and declares these values in Server Env, so the Console shows them
 * and Env providers can supply them. They stay optional: a missing value fails only the invocation that needs it.
 */
export const builtInGatewayEnv = {
  anthropic: { apiKey: { names: ["ANTHROPIC_API_KEY"], secret: true } },
  cliproxy: { apiKey: { names: ["CLIPROXY_API_KEY"], secret: true }, url: { names: ["CLIPROXY_URL"] } },
  cloudflareAccess: { clientId: { names: ["CF_ACCESS_CLIENT_ID"], secret: true }, clientSecret: { names: ["CF_ACCESS_CLIENT_SECRET"], secret: true } },
  litellm: { apiKey: { names: ["LITELLM_API_KEY"], secret: true }, url: { names: ["LITELLM_URL"] } },
  ollama: { apiKey: { names: ["OLLAMA_API_KEY"], secret: true }, url: { names: ["OLLAMA_URL"] } },
  openai: { apiKey: { names: ["OPENAI_API_KEY"], secret: true } },
  openrouter: { apiKey: { names: ["OPENROUTER_API_KEY"], secret: true } },
  vercel: { apiKey: { names: ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"], secret: true } },
} as const satisfies Record<string, Record<string, BuiltInEnvField>>

export type BuiltInGatewayEnv = typeof builtInGatewayEnv

const gatewayEnvFields: Readonly<Record<string, Readonly<Record<string, BuiltInEnvField>>>> = builtInGatewayEnv

/** Read one gateway preset value from Server Env, or from its host variables without hubEnv(). */
export async function gatewayEnvValue<TGateway extends keyof BuiltInGatewayEnv>(
  gateway: TGateway,
  field: keyof BuiltInGatewayEnv[TGateway] & string,
  context: BuiltInEnvContext,
): Promise<unknown> {
  return (await readBuiltInEnv(gateway, gatewayEnvFields[gateway] ?? {}, [field], context))[field]
}

/** The host variable names of one gateway preset value, for error messages and docs. */
export function gatewayEnvNames<TGateway extends keyof BuiltInGatewayEnv>(
  gateway: TGateway,
  field: keyof BuiltInGatewayEnv[TGateway] & string,
): readonly string[] {
  return gatewayEnvFields[gateway]?.[field]?.names ?? []
}
