import { readonly, shallowRef, watch } from "vue"

import { ConsoleRequestError, isRetryableConsoleRequestError } from "../client/request"

export function useConsoleConnectionUnavailable(state: () => { errors: unknown[]; pending: boolean }) {
  const unavailable = shallowRef(false)
  watch(state, ({ errors, pending }) => {
    // Request resources clear their errors before a retry settles.
    if (unavailable.value && pending) return
    const failures = errors.filter(Boolean)
    unavailable.value = failures.length > 1 && failures.every((error) => {
      // Connection polling treats unclassified errors as an outage. Request errors
      // still use the transient status policy so permanent responses do not mask.
      return error instanceof Error && !(error instanceof ConsoleRequestError)
        ? true
        : isRetryableConsoleRequestError(error)
    })
  }, { immediate: true, flush: "sync" })
  return readonly(unavailable)
}
