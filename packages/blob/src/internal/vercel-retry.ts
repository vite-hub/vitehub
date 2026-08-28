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
    const message = error ? Reflect.get(Object(error), "message") : undefined
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
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const value = operation((error = new Error("Aborted")) => {
          bailError = error || new Error("Aborted")
          reject(bailError)
        }, attempt)
        Promise.resolve(value).then(resolve, reject)
      })
      return result
    }
    catch (error) {
      if (bailError !== undefined || (error && Reflect.get(Object(error), "bail")) || Number.isNaN(retries)) throw error
      errors.push(error)
      if (attempt > retries) throw mainError(errors)
      options.onRetry?.(error, attempt)
      const random = options.randomize === true ? Math.random() + 1 : 1
      const timeout = Math.min(Math.round(random * Math.max(minTimeout, 1) * factor ** (attempt - 1)), maxTimeout)
      await new Promise(resolve => setTimeout(resolve, timeout))
    }
  }
}
