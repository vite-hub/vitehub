import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Database from "../src/console/runtime/components/console-database.vue"
import type { ConsoleDatabase, ConsoleDatabaseRowField } from "../src/console/runtime/components/console-database-model"

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
  database: ConsoleDatabase
  tableRows: Array<Record<string, string>>
  rowOpen: boolean
  rowFields: ConsoleDatabaseRowField[]
  selectRow: (event: Event, row: { index: number }) => void
  setSort: (value: string) => void
  toggleDirection: () => void
  movePage: (delta: -1 | 1) => void
  loadDatabase: () => Promise<void>
  openTable: (name: string) => Promise<void>
}

async function mountDatabase() {
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
  const instance = app.mount({})
  const state = (instance.$ as unknown as { setupState: DatabaseState }).setupState
  await nextTick()
  return { app, state }
}

describe("Console database table selection", () => {
  it.each(["users", "orders"])("keeps controls consistent when selecting %s", async (table) => {
    const { app, state } = await mountDatabase()
    try {
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

  it.each(["refresh", "filter", "sort", "direction", "pagination"])("closes stale row details after %s replaces the rows", async (action) => {
    vi.useFakeTimers()
    const { app, state } = await mountDatabase()
    try {
      state.selectRow(new Event("click"), { index: 0 })
      expect(state.rowOpen).toBe(true)
      expect(state.rowFields.map(field => field.text)).toEqual(["all:0"])
      mocks.request.mockResolvedValueOnce({
        ...state.database,
        rows: [{ id: { kind: "text", value: "replacement" } }],
      })

      if (action === "refresh") await state.loadDatabase()
      else if (action === "filter") state.filter = "alice"
      else if (action === "sort") state.setSort("id")
      else if (action === "direction") state.toggleDirection()
      else state.movePage(1)
      await nextTick()
      await vi.advanceTimersByTimeAsync(250)

      expect(mocks.request).toHaveBeenCalledTimes(2)
      expect(state.tableRows).toEqual([{ id: "replacement" }])
      expect(state.rowOpen).toBe(false)
      expect(state.rowFields).toEqual([])
      state.selectRow(new Event("click"), { index: 0 })
      expect(state.rowOpen).toBe(true)
      expect(state.rowFields.map(field => field.text)).toEqual(["replacement"])
    }
    finally {
      app.unmount()
      vi.useRealTimers()
    }
  })
})
