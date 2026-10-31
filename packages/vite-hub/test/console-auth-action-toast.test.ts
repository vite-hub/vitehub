import { createRenderer, ssrContextKey } from "vue"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ change: vi.fn(), show: vi.fn() }))
vi.mock("../src/console/runtime/client/auth-management", () => ({ authDuration: () => "1 hour", changeAuthConsole: mocks.change }))
vi.mock("../src/console/runtime/client/toast", () => ({ useConsoleToast: () => ({ show: mocks.show }) }))
import Action from "../src/console/runtime/components/console-auth-action.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

async function submit(props: Record<string, unknown>): Promise<void> {
  const app = renderer.createApp({ ...Action, render: () => null }, { base: "/manage", userId: "u1", ...props })
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  try {
    await (instance.$ as unknown as { setupState: { submit: () => Promise<void> } }).setupState.submit()
  } finally { app.unmount() }
}

describe("Auth action toasts", () => {
  it.each([
    [{ action: "ban" }, "User banned"],
    [{ action: "revokeSessions" }, "Sessions revoked"],
    [{ action: "revokeSession", id: "s1" }, "Session revoked"],
    [{ action: "editField", field: { key: "plan", label: "Plan", type: "string", required: false } }, "Plan saved"],
  ])("confirms %o with a toast", async (props, title) => {
    mocks.change.mockReset().mockResolvedValue({})
    mocks.show.mockReset()
    await submit(props)
    expect(mocks.show).toHaveBeenCalledWith({ title })
  })

  it("shows no toast when the action fails or opens the app", async () => {
    mocks.show.mockReset()
    mocks.change.mockReset().mockRejectedValue(new Error("Forbidden"))
    await submit({ action: "ban" })
    mocks.change.mockReset().mockResolvedValue({})
    await submit({ action: "impersonate" })
    expect(mocks.show).not.toHaveBeenCalled()
  })
})
