import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Database from "../src/console/runtime/components/console-database.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface DatabaseState {
  filter: string
  appliedSearch: string
  sort: string
  direction: string
  offset: number
  loading: boolean
  tableRows: Array<Record<string, string>>
  loadDatabase: () => Promise<void>
  openTable: (name: string) => Promise<void>
}

describe("Console database table selection", () => {
  it.each(["users", "orders"])("keeps controls consistent when selecting %s", async (table) => {
    mocks.request.mockReset().mockImplementation(async (_url, { query }) => ({
      database: "main", databases: ["main"], direction: query.direction,
      limit: 50, offset: query.offset, total: 200, search: query.search ?? "",
      table: query.table, relationships: [], rows: [{ id: { kind: "text", value: `${query.search ?? "all"}:${query.offset}` } }],
      tables: ["users", "orders"].map(name => ({ name, columns: [{ key: "id", name: "id", type: "integer" }] })),
    }))
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { name: "vitehub-console-databases", path: "/databases/:database/:table", component: {} },
    ] })
    await router.push("/databases/main/users")
    const app = renderer.createApp({ ...Database, render: () => null }, {
      agentsBase: "/agents", databaseBase: "/database", definitionsBase: "/definitions",
      kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections", view: "data",
    })
    app.use(router)
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: DatabaseState }).setupState
      await nextTick()
      state.filter = "alice"
      state.appliedSearch = "alice"
      state.sort = "id"
      state.direction = "desc"
      state.offset = 50
      await nextTick()
      await state.loadDatabase()
      expect(state.tableRows).toEqual([{ id: "alice:50" }])
      await state.openTable(table)
      await nextTick()
      if (table === "users") {
        expect(state.filter).toBe("alice")
        expect(state.appliedSearch).toBe("alice")
        expect(state.sort).toBe("id")
        expect(state.direction).toBe("desc")
        expect(state.offset).toBe(50)
        expect(state.tableRows).toEqual([{ id: "alice:50" }])
        expect(mocks.request).toHaveBeenCalledTimes(2)
      }
      else {
        expect(state.filter).toBe("")
        expect(state.sort).toBe("")
        expect(state.offset).toBe(0)
        expect(state.tableRows).toEqual([{ id: "all:0" }])
        expect(mocks.request).toHaveBeenLastCalledWith("/database", expect.objectContaining({
          query: expect.objectContaining({ table: "orders", offset: 0, direction: "asc", search: undefined }),
        }))
      }
    }
    finally {
      app.unmount()
    }
  })
})
