import { createRenderer, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ read: vi.fn(), change: vi.fn() }))
vi.mock("../src/console/runtime/client/auth-management", () => ({ readAuthConsole: mocks.read, changeAuthConsole: mocks.change }))
vi.mock("../src/console/runtime/sections", () => ({ rememberConsoleSection() {} }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-auth-detail.vue", () => ({ default: {} }))
import Action from "../src/console/runtime/components/console-auth-action.vue"
import Auth from "../src/console/runtime/components/console-auth.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

describe("Auth Console editing", () => {
  it.each(["string", "number", "boolean", "date", "string[]", "number[]"])("unsets an optional %s field", async (type) => {
    mocks.change.mockReset().mockResolvedValue({})
    const app = renderer.createApp({ ...Action, render: () => null }, {
      base: "/manage", action: "editField", userId: "user", field: { key: "extra", type, required: false },
    })
    app.provide(ssrContextKey, {})
    const instance = app.mount({})
    const state = (instance.$ as unknown as { setupState: { unset: boolean; submit: () => Promise<void> } }).setupState
    try {
      state.unset = true
      await state.submit()
      expect(mocks.change).toHaveBeenCalledWith("/manage", { action: "editField", userId: "user", field: "extra", value: null })
    } finally { app.unmount() }
  })

  it("ignores stale organization successes and errors after selection, closing, and unmount", async () => {
    const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
    mocks.read.mockReset().mockImplementation((_base, operation) => operation === "organization"
      ? new Promise((resolve, reject) => pending.push({ resolve, reject }))
      : Promise.resolve({ storage: { enabled: false } }))
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: {} }] })
    await router.push("/")
    const app = renderer.createApp({ ...Auth, render: () => null }, { sectionsBase: "/sections", managementBase: "/manage" })
    app.use(router)
    app.provide(ssrContextKey, {})
    const instance = app.mount({})
    const state = (instance.$ as unknown as { setupState: {
      openOrganization: (id: string, offset?: number) => Promise<void>; closeOrganization: () => void;
      selectedOrg?: { id: string }; orgError?: unknown; orgOffset: number;
    } }).setupState
    const first = state.openOrganization("first")
    const second = state.openOrganization("second")
    pending[1]!.resolve({ id: "second" })
    await second
    pending[0]!.resolve({ id: "first" })
    await first
    expect(state.selectedOrg?.id).toBe("second")
    const page = state.openOrganization("second", 25)
    state.closeOrganization()
    pending[2]!.resolve({ id: "second" })
    await page
    expect(state.selectedOrg).toBeUndefined()
    expect(state.orgOffset).toBe(0)
    const failed = state.openOrganization("third")
    state.closeOrganization()
    pending[3]!.reject(new Error("stale"))
    await failed
    expect(state.orgError).toBeUndefined()
    const last = state.openOrganization("last")
    app.unmount()
    pending[4]!.resolve({ id: "last" })
    await last
    expect(state.selectedOrg).toBeUndefined()
  })
})
