interface RetryOptions {
  factor?: number
  maxTimeout?: number
  minTimeout?: number
  onRetry?: (error: unknown, attempt: number) => void
  randomize?: boolean
  retries?: number
}

function mainError(errors: unknown[]): unknown {
  const counts = new Map<unknown, number>()
  let selected = errors[0]
  let selectedCount = 0

  for (const error of errors) {
    const message = error && typeof error === "object" ? Reflect.get(error, "message") : undefined
    const count = (counts.get(message) ?? 0) + 1
    counts.set(message, count)
    if (count >= selectedCount) {
      selected = error
      selectedCount = count
    }
  }

  return selected
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

  for (let attempt = 1; ; attempt++) {
    let bailError: unknown
    let rejectBail!: (error: unknown) => void
    const bailPromise = new Promise<never>((_, reject) => {
      rejectBail = reject
    })
    try {
      const result = await Promise.race([Promise.resolve().then(() => operation((error = new Error("Aborted")) => {
        bailError = error || new Error("Aborted")
        rejectBail(bailError)
      }, attempt)), bailPromise])
      return result
    }
    catch (error) {
      if (bailError !== undefined || (error && typeof error === "object" && Reflect.get(error, "bail")) || Number.isNaN(retries)) throw error
      errors.push(error)
      if (attempt > retries) throw mainError(errors)
      options.onRetry?.(error, attempt)
      const random = options.randomize === false ? 1 : Math.random() + 1
      const timeout = Math.min(Math.round(random * Math.max(minTimeout, 1) * factor ** (attempt - 1)), maxTimeout)
      await new Promise(resolve => setTimeout(resolve, timeout))
    }
  }
}
