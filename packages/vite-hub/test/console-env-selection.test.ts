import { createRenderer, nextTick, ssrContextKey } from "vue"
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Env from "../src/console/runtime/components/console-env.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

it("restores declaration rows when a status check fails with the attention filter active", async () => {
  const entries = ["token", "label"].map(name => ({
    path: `env.server.${name}`, source: "env", secret: false, required: true, hasDefault: false,
  }))
  mocks.request.mockResolvedValueOnce({ entries }).mockResolvedValueOnce({
    entries, status: entries.map((entry, index) => ({ path: entry.path, blocking: index === 0, status: index === 0 ? "missing" : "available" })),
  }).mockRejectedValueOnce(new Error("Status unavailable"))
  const app = renderer.createApp({ ...Env, render: () => null }, {
    agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", envBase: "/env",
    managementBase: "/management", searchBase: "/search", sectionsBase: "/sections",
  })
  app.provide(ssrContextKey, {})
  try {
    const instance = app.mount({})
    const state = (instance.$ as unknown as { setupState: {
      refresh: (includeStatus: boolean) => Promise<void>
      attentionOnly: boolean
      rows: typeof entries
      statusFailed: boolean
    } }).setupState
    await nextTick()
    await state.refresh(true)
    state.attentionOnly = true
    expect(state.rows).toEqual([entries[0]])
    await state.refresh(true)
    expect(state.statusFailed).toBe(true)
    expect(state.rows).toEqual(entries)
    expect(state.attentionOnly).toBe(false)
  }
  finally {
    app.unmount()
  }
})
