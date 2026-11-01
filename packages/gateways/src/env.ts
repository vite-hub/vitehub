import type { AiGatewayContext } from "./types.ts"

/** One preset value that is read from the environment when the preset does not receive it. */
export interface AiGatewayEnvField {
  /** Vendor variable names in lookup order, after the `VITEHUB_` name. */
  names: readonly [string, ...string[]]
  secret?: true
}

/**
 * The variables that each preset reads, keyed by preset and then by field. ViteHub declares the presets that Agent files
 * use in Server Env as `env.server.<preset>.<field>`.
 */
/** The presets that read the environment. */
export type AiGatewayEnvPreset = "anthropic" | "cliproxy" | "cloudflare" | "cloudflareAccess" | "litellm" | "ollama" | "openai" | "openrouter" | "typesafe" | "vercel"

export const aiGatewayEnv: Readonly<Record<AiGatewayEnvPreset, Readonly<Record<string, AiGatewayEnvField>>>> = {
  anthropic: { apiKey: { names: ["ANTHROPIC_API_KEY"], secret: true } },
  cliproxy: { apiKey: { names: ["CLIPROXY_API_KEY"], secret: true }, url: { names: ["CLIPROXY_URL"] } },
  cloudflare: {
    accountId: { names: ["CLOUDFLARE_ACCOUNT_ID"] },
    gatewayId: { names: ["CLOUDFLARE_AI_GATEWAY_ID"] },
    providerApiKey: { names: ["CLOUDFLARE_AI_GATEWAY_API_KEY"], secret: true },
    slug: { names: ["CLOUDFLARE_AI_GATEWAY_SLUG"] },
    token: { names: ["CLOUDFLARE_AI_GATEWAY_TOKEN"], secret: true },
    typesafeApiKey: { names: ["TYPESAFE_API_KEY"], secret: true },
  },
  cloudflareAccess: { clientId: { names: ["CF_ACCESS_CLIENT_ID"], secret: true }, clientSecret: { names: ["CF_ACCESS_CLIENT_SECRET"], secret: true } },
  litellm: { apiKey: { names: ["LITELLM_API_KEY"], secret: true }, url: { names: ["LITELLM_URL"] } },
  ollama: { apiKey: { names: ["OLLAMA_API_KEY"], secret: true }, url: { names: ["OLLAMA_URL"] } },
  openai: { apiKey: { names: ["OPENAI_API_KEY"], secret: true } },
  openrouter: { apiKey: { names: ["OPENROUTER_API_KEY"], secret: true } },
  typesafe: { apiKey: { names: ["TYPESAFE_API_KEY"], secret: true }, model: { names: ["TYPESAFE_DEFAULT_MODEL"] } },
  vercel: {
    apiKey: { names: ["AI_GATEWAY_API_KEY"], secret: true },
    oidcToken: { names: ["VERCEL_OIDC_TOKEN"], secret: true },
  },
}

/** A field of a preset, such as `apiKey`. */
export type AiGatewayEnvFieldName<_TPreset extends AiGatewayEnvPreset = AiGatewayEnvPreset> = string

const fields: Readonly<Record<string, Readonly<Record<string, AiGatewayEnvField>>>> = aiGatewayEnv

function nameParts(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.toUpperCase())
}

/** The variables of one preset value in lookup order: `VITEHUB_<PRESET>_<FIELD>`, then the vendor names. */
export function aiGatewayEnvNames<TPreset extends AiGatewayEnvPreset>(preset: TPreset, field: AiGatewayEnvFieldName<TPreset>): string[] {
  const vendor = fields[preset]?.[field]?.names ?? []
  return [...new Set([["VITEHUB", ...nameParts(preset), ...nameParts(field)].join("_"), ...vendor])]
}

/** The vendor names of one preset value, for diagnostics. */
export function aiGatewayVendorNames<TPreset extends AiGatewayEnvPreset>(preset: TPreset, field: AiGatewayEnvFieldName<TPreset>): readonly string[] {
  return fields[preset]?.[field]?.names ?? []
}

/** One preset value from `context.env`, else from `process.env`. An empty variable counts as unset. */
export async function readAiGatewayEnv<TPreset extends AiGatewayEnvPreset>(
  context: AiGatewayContext,
  preset: TPreset,
  field: AiGatewayEnvFieldName<TPreset>,
): Promise<unknown> {
  if (context.env) return await context.env(preset, field)
  return aiGatewayEnvNames(preset, field)
    .map(name => globalThis.process?.env?.[name])
    .find(value => value !== undefined && value !== "")
}
