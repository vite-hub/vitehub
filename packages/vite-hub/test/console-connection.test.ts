import { effectScope, ref } from "vue"
import { expect, it } from "vitest"

import { ConsoleRequestError } from "../src/console/runtime/client/request"
import { useConsoleConnectionUnavailable } from "../src/console/runtime/components/console-connection"

it("preserves the outage through automatic polling and the complete reconnect attempt", () => {
  const scope = effectScope()
  const errors = ref<unknown[]>([new Error("offline"), new Error("offline")])
  const pending = ref(false)
  const unavailable = scope.run(() => useConsoleConnectionUnavailable(() => ({
    errors: errors.value, pending: pending.value,
  })))!
  expect(unavailable.value).toBe(true)

  pending.value = true
  errors.value = [errors.value[0], null]
  expect(unavailable.value).toBe(true)
  errors.value = [errors.value[0], new Error("offline")]
  pending.value = false
  expect(unavailable.value).toBe(true)

  pending.value = true
  errors.value = [null, null]
  expect(unavailable.value).toBe(true)
  pending.value = false
  expect(unavailable.value).toBe(false)
  scope.stop()
})

it("leaves independent request failures in their owning views after recovery", () => {
  const scope = effectScope()
  const errors = ref<unknown[]>([new Error("offline")])
  const pending = ref(false)
  const unavailable = scope.run(() => useConsoleConnectionUnavailable(() => ({
    errors: errors.value, pending: pending.value,
  })))!
  expect(unavailable.value).toBe(false)
  errors.value = [new Error("offline"), new Error("offline")]
  expect(unavailable.value).toBe(true)
  pending.value = true
  errors.value = [null, new ConsoleRequestError(404)]
  expect(unavailable.value).toBe(true)
  pending.value = false
  expect(unavailable.value).toBe(false)
  scope.stop()
})
