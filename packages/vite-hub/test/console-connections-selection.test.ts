// @vitest-environment happy-dom
import { createRenderer, nextTick, ssrContextKey } from "vue"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/connections-management", async importOriginal => ({
  ...await importOriginal<typeof import("../src/console/runtime/client/connections-management")>(),
  requestConnectionsManagement: mocks.request,
}))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-connections-details.vue", () => ({ default: {} }))

import Connections from "../src/console/runtime/components/console-connections.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface ConnectionsState {
  pending: Map<string, number>
  refresh: () => Promise<void>
}

const connection = (name: string) => ({
  account: undefined,
  actions: [],
  credential: "oauth2",
  name,
  provider: "test",
  scopes: { declared: [], granted: [], missing: [] },
  status: "connected",
})

describe("Console connection approval counts", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("keeps %s counts isolated", async (name) => {
    mocks.request.mockReset()
      .mockResolvedValueOnce({ connections: [connection(name)] })
      .mockResolvedValueOnce({ counts: { [name]: 3 } })
    const app = renderer.createApp({ ...Connections, render: () => null }, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv",
      managementBase: "/connections", searchBase: "/search", sectionsBase: "/sections",
    })
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: ConnectionsState }).setupState
      await nextTick()
      await nextTick()
      expect(state.pending.get(name)).toBe(3)
      expect(state.pending.get("missing")).toBeUndefined()
    }
    finally {
      app.unmount()
    }
  })
})
