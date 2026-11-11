import { readEnv } from "@vite-hub/internal/env"

import type {
  ResolvedKVModuleOptions,
  ResolvedUpstashKVStoreConfig,
} from "../types.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { upstashTokenEnvNames, upstashUrlEnvNames } from "../integrations/upstash.ts"

function isMaskedValue(value: string | undefined) {
  return !value || /^\*+$/.test(value)
}

function assertRuntimeValue(value: string | undefined, envNames: readonly string[]) {
  if (isMaskedValue(value)) {
    const names = envNames.map(name => `\`${name}\``).join(" or ")
    throw kvErrorDiagnostics.KV_MISSING_ENV({ driver: "upstash", names })
  }
}

/** Fills credentials without validating them, so development still reports missing env on the first operation. */
export function resolveUpstashRuntimeValues(
  config: ResolvedUpstashKVStoreConfig,
  env: Record<string, string | undefined>,
): ResolvedUpstashKVStoreConfig {
  const completeEnvPair = upstashUrlEnvNames
    .map((urlName, index) => [readEnv(env, urlName), readEnv(env, upstashTokenEnvNames[index])] as const)
    .find(([url, token]) => url && token)
  const envUrl = readEnv(env, ...upstashUrlEnvNames)
  const envToken = readEnv(env, ...upstashTokenEnvNames)
  const hasMaskedPair = isMaskedValue(config.url) && isMaskedValue(config.token)
  const resolveMaskedValue = (value: string | undefined, pairValue: string | undefined, fallback: string | undefined) =>
    isMaskedValue(value) ? (pairValue || fallback || value || "********") : (value ?? "********")

  return {
    ...config,
    token: resolveMaskedValue(config.token, completeEnvPair?.[1], hasMaskedPair ? undefined : envToken),
    url: resolveMaskedValue(config.url, completeEnvPair?.[0], hasMaskedPair ? undefined : envUrl),
  }
}

export function resolveRuntimeKVOptions(
  config: false | ResolvedKVModuleOptions | undefined,
  env: Record<string, string | undefined> = process.env,
): false | ResolvedKVModuleOptions | undefined {
  if (!config || config.store.driver !== "upstash") {
    return config
  }

  const store = resolveUpstashRuntimeValues(config.store, env)
  assertRuntimeValue(store.url, upstashUrlEnvNames)
  assertRuntimeValue(store.token, upstashTokenEnvNames)
  return {
    ...config,
    store,
  } satisfies ResolvedKVModuleOptions
}
