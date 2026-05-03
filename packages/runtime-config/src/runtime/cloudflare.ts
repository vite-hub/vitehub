import { getCloudflareEnv } from "@vitehub/internal/runtime/cloudflare-env"

import { getRuntimeConfigRegistry } from "./server.ts"

import type { CloudflareRuntimeConfigResult, RuntimeConfigRuntimeDeclaration } from "../types.ts"

export function getCloudflareRuntime(event: unknown): CloudflareRuntimeConfigResult {
  const env = getCloudflareEnv(event)
  if (!env) {
    throw new Error("[vitehub] Cloudflare runtime env is not available on this event.")
  }

  const registry = getRuntimeConfigRegistry().cloudflare || {}
  return {
    bindings: resolveBindings(registry.bindings || {}, env),
    secrets: resolveRuntimeValues(registry.secrets, env, "secret"),
    vars: resolveRuntimeValues(registry.vars, env, "var"),
  }
}

function resolveBindings(
  bindings: NonNullable<NonNullable<ReturnType<typeof getRuntimeConfigRegistry>["cloudflare"]>["bindings"]>,
  env: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, binding] of Object.entries(bindings || {})) {
    const value = env[binding.bindingName]
    if (typeof value === "undefined") {
      throw new Error(`[vitehub] Missing Cloudflare binding ${binding.bindingName} for runtime.cloudflare.bindings.${key}.`)
    }
    values[key] = value
  }
  return values
}

function resolveRuntimeValues(
  declarations: Record<string, RuntimeConfigRuntimeDeclaration> | undefined,
  env: Record<string, unknown>,
  label: "secret" | "var",
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, declaration] of Object.entries(declarations || {})) {
    const value = env[declaration.envName] ?? declaration.default
    if (typeof value === "undefined") {
      throw new Error(`[vitehub] Missing Cloudflare ${label} ${declaration.envName} for runtime.cloudflare.${label === "secret" ? "secrets" : "vars"}.${key}.`)
    }
    values[key] = value
  }
  return values
}
