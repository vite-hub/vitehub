import { createRenderer, ssrContextKey } from "vue"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request.ts", () => ({ requestConsole: mocks.request }))

import Cancel from "../src/console/runtime/components/console-session-cancel.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface CancelState {
  cancelInvocation: () => Promise<void>
  label: string
  notice?: string
}

describe("Console stale execution abort", () => {
  it.each([
    { delivery: "local", notEnforcedBy: "run", notice: "Local abort requested, not enforced by run" },
    { notice: "Journal is terminal; no local execution received an abort" },
  ])("keeps terminal abort usable after an earlier cancellation and reports $notice", async ({ notice, ...result }) => {
    mocks.request.mockReset().mockResolvedValueOnce({ id: "stale", outcome: "terminal", status: "failed", ...result })
    const refreshed = vi.fn()
    const app = renderer.createApp({ ...Cancel, render: () => null }, {
      apiBase: "/invocations", cancelRequested: true, id: "stale", terminal: true, onCancelled: refreshed,
    })
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: CancelState }).setupState
      expect(state.label).toBe("Abort stale execution")
      await state.cancelInvocation()
      expect(mocks.request).toHaveBeenCalledExactlyOnceWith("/invocations/stale", { body: { action: "cancel" }, method: "POST" })
      expect(state.notice).toBe(notice)
      expect(refreshed).toHaveBeenCalledExactlyOnceWith("stale")
    }
    finally { app.unmount() }
  })
})
