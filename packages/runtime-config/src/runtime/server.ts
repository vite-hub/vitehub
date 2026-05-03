import type { RuntimeConfigRegistry, RuntimeConfigResult, RuntimeConfigRuntimeDeclaration } from "../types.ts"

let registry: RuntimeConfigRegistry = {}

export function setRuntimeConfigRegistry(nextRegistry: RuntimeConfigRegistry): void {
  registry = nextRegistry
}

export function getRuntimeConfigRegistry(): RuntimeConfigRegistry {
  return registry
}

export function getRuntimeConfig(_event?: unknown): RuntimeConfigResult {
  return {
    public: resolveRuntimeValues(registry.public, process.env),
    server: resolveRuntimeValues(registry.server, process.env),
  }
}

export function getPublicRuntimeConfigData(_event?: unknown): Record<string, unknown> {
  return resolveRuntimeValues(registry.public, process.env)
}

function resolveRuntimeValues(
  declarations: Record<string, RuntimeConfigRuntimeDeclaration> | undefined,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, declaration] of Object.entries(declarations || {})) {
    const value = env[declaration.envName] ?? declaration.default
    if (typeof value === "undefined") {
      throw new Error(`[vitehub] Missing runtime config value ${key} from ${declaration.envName}.`)
    }
    values[key] = value
  }
  return values
}
