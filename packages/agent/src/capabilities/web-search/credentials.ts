import type { WebSearchCredential, WebSearchProviderInput, WebSearchProviderOptions } from "./types.ts"

export interface ResolvedWebSearchProviderOptions {
  apiKey?: string
  baseURL?: string
  name: string
}

function providerEnvName(provider: string) {
  return provider.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()
}

function unseal(value: string | { unseal: () => string } | undefined): string | undefined {
  if (typeof value === "string") return value
  if (value && typeof value.unseal === "function") return value.unseal()
  return undefined
}

function resolveCredential(value: WebSearchCredential | undefined): string | undefined {
  return typeof value === "function" ? unseal(value()) : unseal(value)
}

export function normalizeWebSearchProviderInput(provider: WebSearchProviderInput): WebSearchProviderOptions {
  if (typeof provider === "string") return { name: provider }
  if (!provider || typeof provider !== "object" || typeof provider.name !== "string" || !provider.name.trim()) {
    throw new TypeError("[vitehub] webSearch({ mode: \"tool\" }) requires a provider name.")
  }
  return provider
}

export function resolveWebSearchProvider(provider: WebSearchProviderInput, env: Record<string, string | undefined> = process.env): ResolvedWebSearchProviderOptions {
  const options = normalizeWebSearchProviderInput(provider)
  const envName = providerEnvName(options.name)
  const apiKey = resolveCredential(options.apiKey)
    ?? env[`VITEHUB_${envName}_API_KEY`]
    ?? env[`${envName}_API_KEY`]

  return {
    apiKey,
    baseURL: options.baseURL,
    name: options.name,
  }
}
