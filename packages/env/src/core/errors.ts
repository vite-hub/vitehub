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

export class EnvError<TCode extends EnvErrorCode = EnvErrorCode>
  extends ViteHubError<TCode, EnvErrorDetails<TCode>> {
  constructor(options: EnvErrorOptions<TCode>) {
    if (!Object.hasOwn(envErrorMessages, options.code)) {
      throw new TypeError("[vitehub] EnvError requires a known Env error code.")
    }
    const details = normalizeDetails(options.code, options.details)
    super(options.code, envErrorMessages[options.code], {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(details === undefined ? {} : { details }),
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
  details: EnvErrorDetails<TCode> | undefined,
): EnvErrorDetails<TCode> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined
  const normalized: { path?: string, source?: EnvSourceIdentifier } = {}
  if ((code === "ENV_DECLARATION_INVALID" || code === "ENV_REQUIRED_MISSING") && "path" in details) {
    const path = safePath(details.path)
    if (path) normalized.path = path
  }
  if (code !== "ENV_DECLARATION_INVALID" && "source" in details && envSourceIdentifierSet.has(details.source as EnvSourceIdentifier)) {
    normalized.source = details.source as EnvSourceIdentifier
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
