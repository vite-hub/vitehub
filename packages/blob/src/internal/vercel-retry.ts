interface RetryOptions {
  factor?: number
  maxTimeout?: number
  minTimeout?: number
  onRetry?: (error: unknown, attempt: number) => void
  randomize?: boolean
  retries?: number
}

export default async function retry<T>(
  operation: (bail: (error?: unknown) => void, attempt: number) => T | Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 10
  const factor = options.factor ?? 2
  const minTimeout = options.minTimeout ?? 1_000
  const maxTimeout = options.maxTimeout ?? Infinity
  const errors: unknown[] = []

  function mainError() {
    const counts = new Map<string, number>()
    let selected = errors.at(-1)
    let selectedCount = 0
    for (const error of errors) {
      const message = error instanceof Error ? error.message : String(error)
      const count = (counts.get(message) || 0) + 1
      counts.set(message, count)
      if (count >= selectedCount) {
        selected = error
        selectedCount = count
      }
    }
    return selected
  }

  for (let attempt = 1; ; attempt++) {
    let bailError: unknown
    try {
      const result = await operation((error = new Error("Aborted")) => {
        bailError = error || new Error("Aborted")
      }, attempt)
      if (bailError !== undefined) throw bailError
      return result
    }
    catch (error) {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Retry failures cross an untyped dependency boundary, so preserve async-retry's bail marker check.
      if (bailError !== undefined || (error && typeof error === "object" && Reflect.get(error, "bail")) || Number.isNaN(retries)) throw error
      errors.push(error)
      if (attempt > retries) throw mainError()
      options.onRetry?.(error, attempt)
      const random = options.randomize === false ? 1 : Math.random() + 1
      const timeout = Math.min(Math.round(random * Math.max(minTimeout, 1) * factor ** (attempt - 1)), maxTimeout)
      await new Promise(resolve => setTimeout(resolve, timeout))
    }
  }
}
