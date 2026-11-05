import { onScopeDispose, readonly, ref, watch } from "vue"

import type { Ref } from "vue"

/** Any Choices object. Its `resolve()` parameters do not matter here. */
export interface ChoicesLike {
  resolve: (text: never, ...args: never[]) => Promise<unknown>
}

/** The selection that `resolve()` of a Choices object returns on success. Use it with `typeof yourChoices`. */
export type ChoicesSelectionOf<TChoices extends ChoicesLike> = Extract<Awaited<ReturnType<TChoices["resolve"]>>, readonly [undefined, unknown]>[1]

export type ChoicesStatus = "error" | "idle" | "ready" | "thinking"

export interface UseChoicesOptions<TSelection> {
  /**
   * Wait this many milliseconds after the last keystroke, then resolve. Leave it out to resolve only when you call
   * `submit()`.
   */
  debounce?: number
  /** The text must be at least this long before a debounced resolve runs. Defaults to `3`. */
  minLength?: number
  /** Called by `clear()`, so you can reset your own state, such as the filters that the last selection set. */
  onClear?: () => void
  /** Called with each new selection. Apply it to your own state here. */
  onSelect?: (selection: TSelection) => void
  /**
   * Your bridge to the server: send the text, return the selection. Throw when the request fails.
   * Pass `signal` to your request so a newer text can cancel an older one.
   */
  resolve: (text: string, context: { signal: AbortSignal }) => Promise<TSelection>
}

export interface UseChoicesResult<TSelection> {
  /** Cancels the pending request and goes back to `idle`. */
  abort: () => void
  /** Clears the text, the selection, and the error. */
  clear: () => void
  /** The error of the last request, or `undefined`. */
  error: Readonly<Ref<Error | undefined>>
  /** The latest selection, or `undefined`. A newer request keeps it until it finishes. */
  selection: Readonly<Ref<TSelection | undefined>>
  status: Readonly<Ref<ChoicesStatus>>
  /** Resolves the current text now. */
  submit: () => Promise<void>
  /** Bind this to your input. */
  text: Ref<string>
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Turns the text of an input into a selection through a function that you write. It owns the status, the debounce, and
 * the cancelation of older requests. It does not know your server, your store, or your UI.
 *
 * Give the type of your Choices as the generic, for example `useChoices<typeof forecast>({ ... })`. Import it with
 * `import type`, so no server code reaches the browser.
 */
export function useChoices<TChoices extends ChoicesLike>(options: UseChoicesOptions<ChoicesSelectionOf<TChoices>>): UseChoicesResult<ChoicesSelectionOf<TChoices>>
export function useChoices<TSelection>(options: UseChoicesOptions<TSelection>): UseChoicesResult<TSelection>
export function useChoices<TSelection>(options: UseChoicesOptions<TSelection>): UseChoicesResult<TSelection> {
  const text = ref("")
  const status = ref<ChoicesStatus>("idle")
  const selection = ref<TSelection>()
  const error = ref<Error>()
  const minLength = options.minLength ?? 3
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function cancel(): void {
    clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }

  async function submit(): Promise<void> {
    clearTimeout(timer)
    timer = undefined
    const value = text.value.trim()
    controller?.abort()
    if (!value) {
      controller = undefined
      status.value = "idle"
      return
    }
    const current = new AbortController()
    controller = current
    status.value = "thinking"
    error.value = undefined
    try {
      const result = await options.resolve(value, { signal: current.signal })
      if (current.signal.aborted) return
      selection.value = result
      status.value = "ready"
      options.onSelect?.(result)
    }
    catch (cause) {
      if (current.signal.aborted) return
      error.value = toError(cause)
      status.value = "error"
    }
  }

  function abort(): void {
    cancel()
    status.value = "idle"
  }

  function clear(): void {
    cancel()
    text.value = ""
    selection.value = undefined
    error.value = undefined
    status.value = "idle"
    options.onClear?.()
  }

  if (options.debounce !== undefined) {
    const delay = options.debounce
    watch(text, (value) => {
      cancel()
      if (status.value === "thinking") status.value = "idle"
      if (value.trim().length < minLength) {
        return
      }
      timer = setTimeout(() => void submit(), delay)
    }, { flush: "sync" })
  }

  onScopeDispose(cancel)

  return { abort, clear, error: readonly(error), selection: readonly(selection) as Readonly<Ref<TSelection | undefined>>, status: readonly(status), submit, text }
}
