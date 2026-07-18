import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorDetails, ViteHubErrorOptions } from "@vite-hub/runtime"

export type EnvErrorCode =
  | "ENV_DECLARATION_INVALID"
  | "ENV_REQUIRED_MISSING"
  | "ENV_RUNTIME_VALUE_INVALID"
  | "ENV_SOURCE_FAILED"

export interface EnvErrorOptions<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends Pick<ViteHubErrorOptions<TDetails>, "cause" | "details"> {
  code: TCode
  message: string
}

export class EnvError<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends ViteHubError<TCode, TDetails> {
  constructor(options: EnvErrorOptions<TCode, TDetails>) {
    const { code, message, ...errorOptions } = options
    super(code, message, errorOptions)
    this.name = "EnvError"
  }
}

export function invalidEnvDeclaration(path: string, message: string): EnvError<"ENV_DECLARATION_INVALID", { path: string }> {
  return new EnvError({
    code: "ENV_DECLARATION_INVALID",
    details: { path },
    message,
  })
}

export function missingRequiredEnv(source: string, message: string, path?: string): EnvError<"ENV_REQUIRED_MISSING", { path?: string, source: string }> {
  return new EnvError({
    code: "ENV_REQUIRED_MISSING",
    details: { ...(path ? { path } : {}), source },
    message,
  })
}

export function invalidRuntimeEnvValue(source: string, message: string): EnvError<"ENV_RUNTIME_VALUE_INVALID", { source: string }> {
  return new EnvError({
    code: "ENV_RUNTIME_VALUE_INVALID",
    details: { source },
    message,
  })
}

export function envSourceFailed(source: string, cause: unknown): EnvError<"ENV_SOURCE_FAILED", { source: string }> {
  return new EnvError({
    cause,
    code: "ENV_SOURCE_FAILED",
    details: { source },
    message: `Env source ${source} failed.`,
  })
}
