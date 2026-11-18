import { defineErrors, type ViteHubError } from '@vite-hub/runtime'

// Keep published codes stable. The docs build writes a page for each code.
export const sandboxTaskRunErrors = /*#__PURE__*/ defineErrors({
  docs: 'https://vitehub.dev/docs/sandbox/diagnostics',
  codes: {
    // Runtime error. `runSandboxTask()` returns it as `[error, undefined]`.
    SANDBOX_TASK_RUN_FAILED: {
      why: ({ name, code }: { name: string, code: string }) => `Sandbox Task ${JSON.stringify(name)} failed with ${code}.`,
      fix: 'Read `error.cause` for the message, `details`, and process output of the failure. `error.data.code` is its code, such as `SANDBOX_TASK_TIMEOUT`.',
      data: ({ name, code }: { name: string, code: string }) => ({ name, code }),
    },
  },
})

/** HTTP status of a failed run: 504 for a timeout, 404 for an unknown task, 400 for invalid input, else 500. */
function statusFor(error: ViteHubError<`SANDBOX_TASK_${string}`>) {
  const status = error.details?.httpStatus
  if (Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599)
    return Number(status)
  if (error.code === 'SANDBOX_TASK_TIMEOUT') return 504
  if (error.code.includes('NOT_FOUND')) return 404
  if (error.code.includes('VALIDATION')) return 400
  return 500
}

/** The error that `runSandboxTask()` returns. The failure stays in `cause`, so `toResponse(error)` sends no process output. */
export function runFailed(name: string, error: ViteHubError<`SANDBOX_TASK_${string}`>) {
  const failure = sandboxTaskRunErrors.SANDBOX_TASK_RUN_FAILED({ name, code: error.code, cause: error })
  return Object.defineProperty(failure, 'status', { configurable: true, value: statusFor(error) })
}
