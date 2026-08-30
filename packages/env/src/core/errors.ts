import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorOptions } from "@vite-hub/runtime"

const envErrorMessages = {
  ENV_DECLARATION_INVALID: "[vitehub] Env declaration is invalid.",
  ENV_ASYNC_REQUIRED: "[vitehub] Server Env requires asynchronous loading.",
  ENV_REQUIRED_MISSING: "[vitehub] Required Env value is missing.",
  ENV_RUNTIME_VALUE_INVALID: "[vitehub] Runtime Env value is invalid.",
  ENV_SOURCE_FAILED: "[vitehub] Env source resolution failed.",
} as const

const envSourceIdentifiers = [
  "custom",
  "env",
  "git:branch",
  "git:commit",
  "git:ref",
  "git:sha",
  "git:tag",
  "package.json",
  "provider",
] as const

export type EnvErrorCode = keyof typeof envErrorMessages
export type EnvSourceIdentifier = typeof envSourceIdentifiers[number]

interface EnvErrorDetailsByCode {
  ENV_ASYNC_REQUIRED: { path?: string }
  ENV_DECLARATION_INVALID: { path?: string }
  ENV_REQUIRED_MISSING: { path?: string, source?: EnvSourceIdentifier }
  ENV_RUNTIME_VALUE_INVALID: { source?: EnvSourceIdentifier }
  ENV_SOURCE_FAILED: { source?: EnvSourceIdentifier }
}

export type EnvErrorDetails<TCode extends EnvErrorCode = EnvErrorCode> = EnvErrorDetailsByCode[TCode]

interface EnvErrorOptions<TCode extends EnvErrorCode = EnvErrorCode>
  extends Pick<ViteHubErrorOptions<EnvErrorDetails<TCode>>, "cause" | "details"> {
  code: TCode
}

const envSourceIdentifierSet = new Set<EnvSourceIdentifier>(envSourceIdentifiers)

function invalidOptions(): never {
  throw new TypeError("[vitehub] Invalid Env error options.")
}

function own(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidOptions()
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor)) invalidOptions()
    return descriptor.value
  }
  catch {
    invalidOptions()
  }
}

function createEnvError<TCode extends EnvErrorCode>(options: EnvErrorOptions<TCode>): ViteHubError<TCode, EnvErrorDetails<TCode>> {
  const code = own(options, "code")
  if (typeof code !== "string" || !Object.hasOwn(envErrorMessages, code)) invalidOptions()
  const cause = own(options, "cause")
  const details = normalizeDetails(code as TCode, own(options, "details"))
  return new ViteHubError(code as TCode, envErrorMessages[code as TCode], {
    ...(cause === undefined ? {} : { cause }),
    ...(details === undefined ? {} : { details }),
  })
}

export function invalidEnvDeclaration(path: string, diagnostic: string): ViteHubError<"ENV_DECLARATION_INVALID", EnvErrorDetails<"ENV_DECLARATION_INVALID">> {
  return createEnvError({
    cause: new TypeError(diagnostic),
    code: "ENV_DECLARATION_INVALID",
    details: optionalPath(path),
  })
}

export function asyncServerEnvRequired(path: string): ViteHubError<"ENV_ASYNC_REQUIRED", EnvErrorDetails<"ENV_ASYNC_REQUIRED">> {
  return createEnvError({
    cause: new TypeError(`Server Env at ${path} uses env.provider(). Use loadServerEnv() or runWithServerEnv().`),
    code: "ENV_ASYNC_REQUIRED",
    details: optionalPath(path),
  })
}

export function missingRequiredEnv(source: string, diagnostic: string, path?: string): ViteHubError<"ENV_REQUIRED_MISSING", EnvErrorDetails<"ENV_REQUIRED_MISSING">> {
  const pathDetails = optionalPath(path)
  return createEnvError({
    cause: new Error(diagnostic),
    code: "ENV_REQUIRED_MISSING",
    details: {
      ...pathDetails,
      source: publicSourceIdentifier(source),
    },
  })
}

export function invalidRuntimeEnvValue(source: string, diagnostic: string): ViteHubError<"ENV_RUNTIME_VALUE_INVALID", EnvErrorDetails<"ENV_RUNTIME_VALUE_INVALID">> {
  return createEnvError({
    cause: new TypeError(diagnostic),
    code: "ENV_RUNTIME_VALUE_INVALID",
    details: { source: publicSourceIdentifier(source) },
  })
}

export function envSourceFailed(source: string, cause: unknown): ViteHubError<"ENV_SOURCE_FAILED", EnvErrorDetails<"ENV_SOURCE_FAILED">> {
  return createEnvError({
    cause,
    code: "ENV_SOURCE_FAILED",
    details: { source: publicSourceIdentifier(source) },
  })
}

export function isAbortError(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false
  try {
    return (value as { name?: unknown }).name === "AbortError"
  }
  catch {
    return false
  }
}

function publicSourceIdentifier(source: string): EnvSourceIdentifier {
  if (envSourceIdentifierSet.has(source as EnvSourceIdentifier)) return source as EnvSourceIdentifier
  if (source.startsWith("env:")) return "env"
  if (source.startsWith("package.json:")) return "package.json"
  return "custom"
}

function normalizeDetails<TCode extends EnvErrorCode>(
  code: TCode,
  details: unknown,
): EnvErrorDetails<TCode> | undefined {
  if (details === undefined) return undefined
  if (typeof details !== "object" || details === null || Array.isArray(details)) invalidOptions()
  const normalized: { path?: string, source?: EnvSourceIdentifier } = {}
  if (code === "ENV_ASYNC_REQUIRED" || code === "ENV_DECLARATION_INVALID" || code === "ENV_REQUIRED_MISSING") {
    const path = safePath(own(details, "path"))
    if (path) normalized.path = path
  }
  if (code !== "ENV_ASYNC_REQUIRED" && code !== "ENV_DECLARATION_INVALID") {
    const source = own(details, "source")
    if (envSourceIdentifierSet.has(source as EnvSourceIdentifier)) normalized.source = source as EnvSourceIdentifier
  }
  return Object.keys(normalized).length ? normalized as EnvErrorDetails<TCode> : undefined
}

function optionalPath(path: unknown): { path?: string } {
  const normalized = safePath(path)
  return normalized ? { path: normalized } : {}
}

function safePath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length > 256) return undefined
  return /^(?:env|runtime)(?:\.[A-Za-z_$][A-Za-z0-9_$-]{0,63}){0,8}$/.test(path) ? path : undefined
}
