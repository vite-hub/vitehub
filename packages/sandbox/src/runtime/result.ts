import type { SandboxRunResult } from "../module-types"
import type { ViteHubError } from "@vite-hub/runtime"

export function ok<TResult>(value: TResult): SandboxRunResult<TResult> {
  return [null, value]
}

export function err<TResult = never>(error: ViteHubError<`SANDBOX_${string}`>): SandboxRunResult<TResult> {
  return [error, undefined]
}
