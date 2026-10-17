import { readonly, shallowRef, watch } from "vue"

import { isRetryableConsoleRequestError } from "../client/request"

export function useConsoleConnectionUnavailable(state: () => { errors: unknown[]; pending: boolean }) {
  const unavailable = shallowRef(false)
  watch(state, ({ errors, pending }) => {
    // Request resources clear their errors before a retry settles.
    if (unavailable.value && pending) return
    const failures = errors.filter(Boolean)
    unavailable.value = failures.length > 1 && failures.every((error) => {
      // Only fetch-boundary failures and transient request responses represent an
      // outage. Resource parser and validation errors must remain in their views.
      return isRetryableConsoleRequestError(error)
    })
  }, { immediate: true, flush: "sync" })
  return readonly(unavailable)
}
