import { createRenderer, ssrContextKey } from "vue"
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ peek: vi.fn(), reset: vi.fn() }))
vi.mock("../src/console/runtime/client/rate-limit", () => ({ peekConsoleRateLimit: mocks.peek, resetConsoleRateLimit: mocks.reset }))

import RateLimit from "../src/console/runtime/components/console-rate-limit.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

it("resets the original peek key while displaying its redacted response", async () => {
  mocks.peek.mockResolvedValue({ name: "login", key: "apiKey=[redacted]", status: "known", counters: [] })
  mocks.reset.mockResolvedValue({ status: "reset" })
  const app = renderer.createApp({ ...RateLimit, render: () => null }, { base: "/rate-limit", name: "login" })
  app.provide(ssrContextKey, {})
  try {
    const instance = app.mount({})
    // SAFETY: These are the component's setup bindings, exposed by Vue's test renderer.
    const state = (instance.$ as unknown as { setupState: {
      key: string
      peeked: { key: string }
      peek: () => Promise<void>
      confirmReset: () => Promise<void>
    } }).setupState
    state.key = "apiKey=customer-123"
    await state.peek()
    expect(state.peeked.key).toBe("apiKey=[redacted]")
    state.key = "another-counter"
    await state.confirmReset()
    expect(mocks.reset).toHaveBeenCalledWith("/rate-limit", "login", "apiKey=customer-123")
  }
  finally {
    app.unmount()
  }
})
