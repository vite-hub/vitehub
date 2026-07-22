import type { SandboxRunResult } from "../module-types"
import type { SandboxError } from "../sandbox/errors"

export function ok<TResult>(value: TResult): SandboxRunResult<TResult> {
  return [null, value]
}

export function err<TResult = never>(error: SandboxError): SandboxRunResult<TResult> {
  return [error, undefined]
}
