type HarnessTurnOptions = {
  abortSignal?: AbortSignal
  emit?: (event: unknown) => void
}

type HarnessTurnControl = {
  done: PromiseLike<void>
}

function bind(target: object, property: PropertyKey): unknown {
  const value = Reflect.get(target, property, target)
  return typeof value === "function" ? value.bind(target) : value
}

function cancellationDetails(value: unknown): { message: string; name: "AbortError" | "TimeoutError" } | undefined {
  if (typeof value !== "object" || value === null) return
  const { message, name } = value as { message?: unknown; name?: unknown }
  if ((name !== "AbortError" && name !== "TimeoutError") || typeof message !== "string") return
  return { message, name }
}

function isExpectedCancellation(signal: AbortSignal | undefined, error: unknown): boolean {
  if (!signal?.aborted) return false
  const errorDetails = cancellationDetails(error)
  if (!errorDetails) return false
  if (error === signal.reason) return true
  const reasonDetails = cancellationDetails(signal.reason)
  return reasonDetails?.name === errorDetails.name && reasonDetails.message === errorDetails.message
}

export function quietExpectedAuxiliaryHarnessCancellation(harness: object): object {
  const wrapSession = (session: object) =>
    new Proxy(session, {
      get(target, property) {
        const value = bind(target, property)
        if (property !== "doPromptTurn" || typeof value !== "function") return value
        return async (...args: unknown[]) => {
          const options = args[0] as HarnessTurnOptions | undefined
          const emit = options?.emit
          const control = (await value(
            ...(emit
              ? [
                  {
                    ...options,
                    emit: (event: unknown) => {
                      const error =
                        (event as { error?: unknown; type?: unknown } | null)?.type === "error"
                          ? (event as { error?: unknown }).error
                          : undefined
                      if (!isExpectedCancellation(options?.abortSignal, error)) emit(event)
                    },
                  },
                  ...args.slice(1),
                ]
              : args),
          )) as HarnessTurnControl
          const done = Promise.resolve(control.done).catch((error) => {
            if (!isExpectedCancellation(options?.abortSignal, error)) throw error
          })
          return new Proxy(control, {
            get(target, property) {
              return property === "done" ? done : bind(target, property)
            },
          })
        }
      },
    })
  const doStart = bind(harness, "doStart")
  if (typeof doStart !== "function") return harness
  return new Proxy(harness, {
    get(target, property) {
      if (property !== "doStart") return bind(target, property)
      return async (...args: unknown[]) => wrapSession((await doStart(...args)) as object)
    },
  })
}
