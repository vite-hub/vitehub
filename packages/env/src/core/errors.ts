import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorOptions } from "@vite-hub/runtime"

const envErrorMessages = {
  ENV_DECLARATION_INVALID: "[vitehub] Env declaration is invalid.",
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
] as const

export type EnvErrorCode = keyof typeof envErrorMessages
export type EnvSourceIdentifier = typeof envSourceIdentifiers[number]

interface EnvErrorDetailsByCode {
  ENV_DECLARATION_INVALID: { path?: string }
  ENV_REQUIRED_MISSING: { path?: string, source?: EnvSourceIdentifier }
  ENV_RUNTIME_VALUE_INVALID: { source?: EnvSourceIdentifier }
  ENV_SOURCE_FAILED: { source?: EnvSourceIdentifier }
}

export type EnvErrorDetails<TCode extends EnvErrorCode = EnvErrorCode> = EnvErrorDetailsByCode[TCode]

export interface EnvErrorOptions<TCode extends EnvErrorCode = EnvErrorCode>
  extends Pick<ViteHubErrorOptions<EnvErrorDetails<TCode>>, "cause" | "details"> {
  code: TCode
}

const envSourceIdentifierSet = new Set<EnvSourceIdentifier>(envSourceIdentifiers)

function invalidEnvErrorOptions(): never {
  throw new TypeError("[vitehub] EnvError requires valid error options.")
}

function readOwnDataProperty(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor)) invalidEnvErrorOptions()
    return descriptor.value
  }
  catch {
    invalidEnvErrorOptions()
  }
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value)
  }
  catch {
    invalidEnvErrorOptions()
  }
}

interface NormalizedEnvError<TCode extends EnvErrorCode> {
  cause?: unknown
  code: TCode
  details?: EnvErrorDetails<TCode>
}

function normalizeEnvError<TCode extends EnvErrorCode>(value: unknown): NormalizedEnvError<TCode> {
  if (typeof value !== "object" || value === null || isArray(value)) invalidEnvErrorOptions()
  const code = readOwnDataProperty(value, "code")
  if (typeof code !== "string" || !Object.hasOwn(envErrorMessages, code)) invalidEnvErrorOptions()
  const cause = readOwnDataProperty(value, "cause")
  const details = normalizeDetails(code as TCode, readOwnDataProperty(value, "details"))
  return {
    ...(cause === undefined ? {} : { cause }),
    code: code as TCode,
    ...(details === undefined ? {} : { details }),
  }
}

export class EnvError<TCode extends EnvErrorCode = EnvErrorCode>
  extends ViteHubError<TCode, EnvErrorDetails<TCode>> {
  constructor(options: EnvErrorOptions<TCode>) {
    const normalized = normalizeEnvError<TCode>(options)
    super(normalized.code, envErrorMessages[normalized.code], {
      ...(normalized.cause === undefined ? {} : { cause: normalized.cause }),
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    })
    this.name = "EnvError"
  }
}

export function invalidEnvDeclaration(path: string, diagnostic: string): EnvError<"ENV_DECLARATION_INVALID"> {
  return new EnvError({
    cause: new TypeError(diagnostic),
    code: "ENV_DECLARATION_INVALID",
    details: optionalPath(path),
  })
}

export function missingRequiredEnv(source: string, diagnostic: string, path?: string): EnvError<"ENV_REQUIRED_MISSING"> {
  const pathDetails = optionalPath(path)
  return new EnvError({
    cause: new Error(diagnostic),
    code: "ENV_REQUIRED_MISSING",
    details: {
      ...pathDetails,
      source: publicSourceIdentifier(source),
    },
  })
}

export function invalidRuntimeEnvValue(source: string, diagnostic: string): EnvError<"ENV_RUNTIME_VALUE_INVALID"> {
  return new EnvError({
    cause: new TypeError(diagnostic),
    code: "ENV_RUNTIME_VALUE_INVALID",
    details: { source: publicSourceIdentifier(source) },
  })
}

export function envSourceFailed(source: string, cause: unknown): EnvError<"ENV_SOURCE_FAILED"> {
  return new EnvError({
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
  if (source.startsWith("custom:")) return "custom"
  return "custom"
}

function normalizeDetails<TCode extends EnvErrorCode>(
  code: TCode,
  details: unknown,
): EnvErrorDetails<TCode> | undefined {
  if (!details || typeof details !== "object" || isArray(details)) return undefined
  const normalized: { path?: string, source?: EnvSourceIdentifier } = {}
  if (code === "ENV_DECLARATION_INVALID" || code === "ENV_REQUIRED_MISSING") {
    const path = safePath(readOwnDataProperty(details, "path"))
    if (path) normalized.path = path
  }
  if (code !== "ENV_DECLARATION_INVALID") {
    const source = readOwnDataProperty(details, "source")
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
