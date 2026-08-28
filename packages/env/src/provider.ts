import type { EnvProvider } from "./types.ts"

export type { EnvProvider, EnvProviderContext, EnvProviderValues } from "./types.ts"

export function defineEnvProvider<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
  const TProvider extends EnvProvider<TEnv> = EnvProvider<TEnv>,
>(provider: TProvider): TProvider {
  if (typeof provider !== "object" || provider === null || Array.isArray(provider) || typeof provider.read !== "function") {
    throw new TypeError("[vitehub] defineEnvProvider() requires a provider with a read({ env, keys, signal }) method.")
  }
  return provider
}
