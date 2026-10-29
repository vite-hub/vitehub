import { createRenderer, nextTick, ssrContextKey } from "vue"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn(), show: vi.fn() }))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: async () => false }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/client/toast", () => ({ useConsoleToast: () => ({ show: mocks.show }) }))
vi.mock("../src/console/runtime/sections", () => ({ rememberConsoleSection: vi.fn() }))
vi.mock("vue-router", () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-page-header.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-page-toolbar.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-status.vue", () => ({ default: {} }))

import KV from "../src/console/runtime/components/console-kv.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface State {
  editing: boolean
  editText: string
  saveEdit: () => Promise<void>
  selectedKey?: string
  selectedStore: string
  selectedValue?: { key: string, store: string, value: string }
  selectKey: (key: string) => Promise<void>
  startEdit: () => void
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function value(key: string, store = "default") {
  return { editable: true, found: true, key, store, type: "string", value: `${store}:${key}` }
}

beforeEach(() => {
  mocks.request.mockReset()
  mocks.show.mockReset()
})

it.each(["pending key", "edited key", "edited store"])("keeps the current selection after saving another %s", async (scenario) => {
  const save = deferred<unknown>()
  const otherValue = deferred<unknown>()
  let otherSignal: AbortSignal | undefined
  mocks.request.mockImplementation((_base, options) => {
    if (options.body?.action === "set") return save.promise
    if (options.query) return Promise.resolve({ keys: ["first", "second"], store: options.query.store, stores: ["default", "other"] })
    if (scenario === "pending key" && options.body.key === "second") {
      otherSignal = options.signal
      return otherValue.promise
    }
    return Promise.resolve(value(options.body.key, options.body.store))
  })
  const app = renderer.createApp({ ...KV, render: () => null }, { agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections" })
  app.provide(ssrContextKey, {})
  try {
    const instance = app.mount({})
    // SAFETY: These are the component setup bindings exposed by Vue's test renderer.
    const state = (instance.$ as unknown as { setupState: State }).setupState
    await vi.waitFor(() => expect(state.selectedValue?.key).toBe("first"))
    state.startEdit()
    state.editText = "saved value"
    const saving = state.saveEdit()
    expect(mocks.request).toHaveBeenLastCalledWith("/kv", expect.objectContaining({ body: { action: "set", key: "first", store: "default", value: "saved value" } }))

    let selection: Promise<void> | undefined
    if (scenario === "edited store") {
      state.selectedStore = "other"
      await vi.waitFor(() => expect(state.selectedValue?.store).toBe("other"))
    }
    else selection = state.selectKey("second")
    if (scenario !== "pending key") {
      await selection
      state.startEdit()
      state.editText = "unsaved edit"
    }
    const callsBeforeSave = mocks.request.mock.calls.length
    save.resolve({})
    await saving
    await nextTick()

    expect(mocks.request).toHaveBeenCalledTimes(callsBeforeSave)
    expect(state.selectedKey).toBe(scenario === "edited store" ? "first" : "second")
    if (scenario === "pending key") {
      expect(otherSignal?.aborted).toBe(false)
      otherValue.resolve(value("second"))
      await selection
      expect(state.selectedValue?.key).toBe("second")
    }
    else {
      expect(state.editing).toBe(true)
      expect(state.editText).toBe("unsaved edit")
      expect(state.selectedValue).toMatchObject(scenario === "edited store" ? value("first", "other") : value("second"))
    }
  }
  finally {
    app.unmount()
  }
})
