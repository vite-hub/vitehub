import { createRenderer, nextTick, ssrContextKey } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: mocks.request }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Definitions from "../src/console/runtime/components/console-definitions.vue"
import type { ConsoleScheduleRunView } from "../src/console/runtime/client/schedule-run"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface ScheduleState {
  canRunSelected: boolean
  loadDefinitions: () => Promise<void>
  recordOpen: boolean
  selectedName: string | undefined
  selectedRun: ConsoleScheduleRunView | undefined
  selectDefinition: (name: string) => void
  runSelectedSchedule: () => Promise<void>
}

describe("Console Schedule result selection", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("shows a result only after running %s", async (name) => {
    const sectionsBase = `/sections/${name}`
    mocks.request.mockReset().mockImplementation(async (url: string) => {
      if (url === sectionsBase) return { sections: ["schedules"], operations: ["schedule.run"] }
      if (url === "/api/_vitehub/console/schedule-run") return { run: { id: "run-1", status: "succeeded" } }
      return {
        section: "schedules", kind: "definition-catalog",
        definitions: [name, "other"].map(name => ({ name, file: `${name}.ts`, source: "static", fields: [], runnable: true })),
      }
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { name: "vitehub-console-schedules", path: "/schedules", component: {} },
    ] })
    await router.push({ path: "/schedules", query: { definition: name } })
    const app = renderer.createApp({ ...Definitions, render: () => null }, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv",
      scheduleRunBase: "/api/_vitehub/console/schedule-run", searchBase: "/search", sectionsBase,
      details: { id: "schedules", label: "Schedules", icon: "i-lucide-calendar", description: "Schedules", view: { kind: "definition-catalog", notice: "Schedule metadata" } },
    })
    app.use(router)
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: ScheduleState }).setupState
      await nextTick()
      await vi.waitFor(() => expect(state.canRunSelected).toBe(true))
      expect(state.selectedName).toBe(name)
      expect(state.selectedRun).toBeUndefined()
      await state.runSelectedSchedule()
      expect(mocks.request).toHaveBeenCalledWith("/api/_vitehub/console/schedule-run", { body: { name }, method: "POST" })
      expect(state.selectedRun).toEqual({ id: "run-1", status: "succeeded" })
      state.selectDefinition("other")
      expect(state.selectedRun).toBeUndefined()
      state.selectDefinition(name)
      expect(state.selectedRun).toEqual({ id: "run-1", status: "succeeded" })
    }
    finally {
      app.unmount()
    }
  })
})

describe("Console record selection URL", () => {
  it.each(["missing", "removed", "retained", "initial retry", "refresh retry"])("normalizes the selection when a record is %s", async (scenario) => {
    const record = { id: "outbox-3", cells: { subject: "Hello" }, fields: [] }
    const response = (present: boolean) => ({ section: "email", kind: "record-table", records: present ? [record] : [] })
    mocks.request.mockReset().mockResolvedValue({ sections: ["email"], operations: [] })
    if (scenario === "initial retry") mocks.request.mockRejectedValueOnce(new Error("Request failed"))
    else mocks.request.mockResolvedValueOnce(response(scenario !== "missing"))
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: "/email", component: {} },
    ] })
    await router.push({ path: "/email", query: { record: record.id, search: "hello" } })
    const app = renderer.createApp({ ...Definitions, render: () => null }, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv",
      searchBase: "/search", sectionsBase: "/sections",
      details: { id: "email", label: "Email", icon: "i-lucide-mail", description: "Email", view: { kind: "record-table", notice: "Outbox", columns: [{ key: "subject", label: "Subject" }] } },
    })
    app.use(router)
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: ScheduleState }).setupState
      await nextTick()
      if (scenario === "refresh retry") {
        expect(state.recordOpen).toBe(true)
        mocks.request.mockRejectedValueOnce(new Error("Request failed"))
        await state.loadDefinitions()
      }
      if (scenario === "initial retry" || scenario === "refresh retry") {
        expect(state.recordOpen).toBe(false)
        expect(router.currentRoute.value.query).toEqual({ record: record.id, search: "hello" })
        mocks.request.mockResolvedValueOnce(response(true))
        await state.loadDefinitions()
      }
      else if (scenario !== "missing") {
        expect(state.recordOpen).toBe(true)
        mocks.request.mockResolvedValueOnce(response(scenario === "retained"))
        await state.loadDefinitions()
      }
      const retained = scenario === "retained" || scenario === "initial retry" || scenario === "refresh retry"
      expect(state.recordOpen).toBe(retained)
      expect(state.selectedName).toBe(retained ? record.id : undefined)
      await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({
        ...(retained ? { record: record.id } : {}), search: "hello",
      }))
    }
    finally {
      app.unmount()
    }
  })
})
