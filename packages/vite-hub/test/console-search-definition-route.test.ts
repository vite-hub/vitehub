import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request, loadConsoleKVPages: vi.fn() }))
vi.mock("vite-hub/source/client", async () => {
  const { ref } = await import("vue")
  return { useCollection: () => ({ pending: ref(false), items: ref([]), error: ref(), refresh: vi.fn() }) }
})

// Nuxt UI composables import `#imports`, which only the Nuxt UI build plugin provides.
vi.mock("@nuxt/ui/composables", () => ({ defineShortcuts: vi.fn() }))

import Search from "../src/console/runtime/components/console-search.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface SearchState {
  open: boolean
  definitionSearchItems: Array<{ label: string, onSelect: () => Promise<void> }>
}

describe("Console definition search navigation", () => {
  it.each(["", "___en"])("targets the selected database and retains other definition routes with suffix %s", async (suffix) => {
    const sectionsBase = `/sections${suffix}`
    mocks.request.mockReset().mockImplementation(async (url, options) => url === sectionsBase
      ? {
          sections: ["databases", "queues"],
          contributions: [{ id: "queues", label: "Queues", description: "Inspect queues", icon: "queue", view: { kind: "definition-catalog", notice: "" } }],
        }
      : { definitions: [{ name: options.query.section === "databases" ? "analytics" : "emails", file: "definition.ts", source: "project" }] })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { name: `vitehub-console-databases${suffix}`, path: "/databases/:database?/:table?", component: {} },
      { name: `vitehub-console-queues${suffix}`, path: "/queues", component: {} },
    ] })
    await router.push("/databases/default/users")
    const app = renderer.createApp({ ...Search, render: () => null }, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase,
    })
    app.use(router)
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: SearchState }).setupState
      await nextTick()
      state.open = true
      await vi.waitFor(() => expect(state.definitionSearchItems).toHaveLength(2))
      await state.definitionSearchItems.find(item => item.label === "analytics")!.onSelect()
      expect(router.currentRoute.value.name).toBe(`vitehub-console-databases${suffix}`)
      expect(router.currentRoute.value.params).toEqual({ database: "analytics" })
      expect(router.currentRoute.value.query).toEqual({})

      await state.definitionSearchItems.find(item => item.label === "emails")!.onSelect()
      expect(router.currentRoute.value.name).toBe(`vitehub-console-queues${suffix}`)
      expect(router.currentRoute.value.query).toEqual({ definition: "emails" })
    }
    finally {
      app.unmount()
    }
  })
})
