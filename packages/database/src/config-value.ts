import type { DatabaseConfigValue, RuntimeEnvDeclarationLike } from "./types.ts"

export function createRuntimeEnvConfigValue(names: string[], defaultValue?: string): RuntimeEnvDeclarationLike {
  return {
    kind: "env-variable",
    source: {
      kind: "env",
      name: names[0]!,
      ...(names.length > 1 ? { names } : {}),
    },
    ...(typeof defaultValue !== "undefined" ? { default: defaultValue } : {}),
  }
}

function getRuntimeEnvNames(value: RuntimeEnvDeclarationLike) {
  return value.source?.names ?? (value.source?.name ? [value.source.name] : [])
}

export function renderConfigValueExpression(value: DatabaseConfigValue | undefined) {
  if (typeof value === "undefined") return
  if (typeof value === "string") return JSON.stringify(value)
  const expressions = getRuntimeEnvNames(value).map(name => `process.env[${JSON.stringify(name)}]`)
  if (typeof value?.default === "string") expressions.push(JSON.stringify(value.default))
  return expressions.length ? expressions.join(" ?? ") : undefined
}

export function resolveConfigValue(value: DatabaseConfigValue | undefined) {
  if (typeof value === "string" || typeof value === "undefined") return value
  for (const name of getRuntimeEnvNames(value)) {
    const resolved = process.env[name]
    if (typeof resolved !== "undefined") return resolved
  }
  return typeof value.default === "string" ? value.default : undefined
}
