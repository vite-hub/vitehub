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
  selectedName: string | undefined
  selectedRun: ConsoleScheduleRunView | undefined
  selectDefinition: (name: string) => void
  runSelectedSchedule: () => Promise<void>
}

describe("Console Schedule result selection", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("shows a result only after running %s", async (name) => {
    mocks.request.mockReset().mockResolvedValueOnce({
      section: "schedules", kind: "definition-catalog",
      definitions: [name, "other"].map(name => ({ name, file: `${name}.ts`, source: "static", fields: [], runnable: true })),
    }).mockResolvedValueOnce({ run: { id: "run-1", status: "succeeded" } })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { name: "vitehub-console-schedules", path: "/schedules", component: {} },
    ] })
    await router.push({ path: "/schedules", query: { definition: name } })
    const app = renderer.createApp({ ...Definitions, render: () => null }, {
      agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv",
      scheduleRunBase: "/api/_vitehub/console/schedule-run", searchBase: "/search", sectionsBase: "/sections",
      details: { id: "schedules", label: "Schedules", icon: "i-lucide-calendar", description: "Schedules", view: { kind: "definition-catalog", notice: "Schedule metadata" } },
    })
    app.use(router)
    app.provide(ssrContextKey, {})
    try {
      const instance = app.mount({})
      const state = (instance.$ as unknown as { setupState: ScheduleState }).setupState
      await nextTick()
      expect(state.selectedName).toBe(name)
      expect(state.selectedRun).toBeUndefined()
      await state.runSelectedSchedule()
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
