import { internalErrorDiagnostics } from "./error-diagnostics.ts"

/**
 * Runs `task` and rejects as soon as `signal` aborts, without waiting for the task.
 *
 * The rejection is `signal.reason`. When the reason is absent, it is an `AbortError` with `message`.
 * When `signal` is already aborted, `task` does not run. The task should stop its own work
 * through the same signal.
 */
export function abortable<T>(
  signal: AbortSignal | undefined,
  message: string,
  task: () => PromiseLike<T> | T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal, message))
      return
    }
    const onAbort = () => reject(abortReason(signal, message))
    signal?.addEventListener("abort", onAbort, { once: true })
    const settle = () => signal?.removeEventListener("abort", onAbort)
    void new Promise<T>(resolveTask => resolveTask(task())).then(
      (value) => {
        settle()
        resolve(value)
      },
      (error: unknown) => {
        settle()
        reject(error)
      },
    )
  })
}

function abortReason(signal: AbortSignal | undefined, message: string): unknown {
  if (signal?.reason !== undefined) return signal.reason
  const error = internalErrorDiagnostics.INTERNAL_R0003({ message })
  error.name = "AbortError"
  return error
}
