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

const emptyCounter = { limit: 5, remaining: 5, used: 0, window: "1m" }
const activeCounter = { ...emptyCounter, remaining: 4, resetAt: 1_780_000_000_000, used: 1 }

it("resets the original peek key while displaying its redacted response", async () => {
  mocks.peek.mockResolvedValue({ name: "login", key: "apiKey=[redacted]", status: "known", counters: [activeCounter] })
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

it.each([
  ["known", [activeCounter], true],
  ["known", [emptyCounter], false],
  ["known", [], false],
  ["known", [emptyCounter, activeCounter], true],
  ["known", [{ ...emptyCounter, remaining: 4, used: 1 }], true],
  ["known", [{ ...emptyCounter, resetAt: activeCounter.resetAt }], true],
  ["unavailable", [], true],
  ["unused", [], false],
  ["unsupported", [], false],
] as const)("offers Reset after a %s peek with counters %j: %s", async (status, counters, offered) => {
  mocks.peek.mockResolvedValue({ name: "login", key: "203.0.113.7", status, counters, reason: "test" })
  const app = renderer.createApp({ ...RateLimit, render: () => null }, { base: "/rate-limit", name: "login" })
  app.provide(ssrContextKey, {})
  try {
    const instance = app.mount({})
    // SAFETY: These are the component's setup bindings, exposed by Vue's test renderer.
    const state = (instance.$ as unknown as { setupState: { canReset: boolean, key: string, peek: () => Promise<void> } }).setupState
    state.key = "203.0.113.7"
    await state.peek()
    expect(state.canReset).toBe(offered)
  }
  finally {
    app.unmount()
  }
})

it("hides Reset when the post-reset peek returns the missing memory counter shape", async () => {
  const target = { name: "login", key: "203.0.113.7", provider: "memory", status: "known" }
  mocks.peek.mockResolvedValueOnce({ ...target, counters: [activeCounter] })
    .mockResolvedValueOnce({ ...target, counters: [emptyCounter] })
  mocks.reset.mockResolvedValue({ status: "reset" })
  const app = renderer.createApp({ ...RateLimit, render: () => null }, { base: "/rate-limit", name: "login" })
  app.provide(ssrContextKey, {})
  try {
    const instance = app.mount({})
    // SAFETY: These are the component's setup bindings, exposed by Vue's test renderer.
    const state = (instance.$ as unknown as { setupState: {
      canReset: boolean
      key: string
      peek: () => Promise<void>
      confirmReset: () => Promise<void>
    } }).setupState
    state.key = target.key
    await state.peek()
    expect(state.canReset).toBe(true)
    await state.confirmReset()
    expect(state.canReset).toBe(false)
  }
  finally {
    app.unmount()
  }
})
