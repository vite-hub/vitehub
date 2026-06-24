export function abortSignalError(signal: AbortSignal, fallbackMessage: string): unknown {
  return signal.reason ?? new Error(fallbackMessage)
}

export async function nextWithAbort<T>(
  next: Promise<IteratorResult<T>>,
  signal: AbortSignal | undefined,
  fallbackMessage: string,
): Promise<IteratorResult<T>> {
  if (!signal) return await next
  if (signal.aborted) throw abortSignalError(signal, fallbackMessage)

  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(abortSignalError(signal, fallbackMessage))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    next.then(
      (result) => {
        signal.removeEventListener("abort", onAbort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}
