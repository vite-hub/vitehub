import { readFileSync } from "node:fs"

import { compile, createRenderer, createSSRApp, defineComponent, h, ssrContextKey } from "vue"
import { renderToString } from "vue/server-renderer"
import { createMemoryHistory, createRouter } from "vue-router"
import { expect, it, vi } from "vitest"

import { consoleScheduleRunDescription } from "../src/console/runtime/client/schedule-run"
import type { ConsoleScheduleRunView } from "../src/console/runtime/client/schedule-run"

vi.mock("../src/console/runtime/client/request", () => ({ requestConsole: async () => ({ sections: ["schedules"], operations: [] }) }))
vi.mock("../src/console/runtime/client/read-only", () => ({ isConsoleSectionReadOnly: async () => false }))
vi.mock("../src/console/runtime/components/console-frame.vue", () => ({ default: {} }))
vi.mock("../src/console/runtime/components/console-search.vue", () => ({ default: {} }))

import Definitions from "../src/console/runtime/components/console-definitions.vue"

const source = readFileSync(new URL("../src/console/runtime/components/console-definitions.vue", import.meta.url), "utf8")
// Render the actual record detail template without the page's navigation and network lifecycle.
const start = source.indexOf('<article v-if="selectedRecord"')
const template = source.slice(start, source.indexOf("</article>", start) + "</article>".length)

// The component's own runStatus(), from a mount that renders nothing.
async function componentRunStatus(): Promise<unknown> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/schedules", component: {} }] })
  await router.push("/schedules")
  const renderer = createRenderer({
    createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
    insert() {}, nextSibling: () => null, parentNode: () => null,
    patchProp() {}, remove() {}, setElementText() {}, setText() {},
  })
  const app = renderer.createApp({ ...Definitions, render: () => null }, {
    agentsBase: "/agents", definitionsBase: "/definitions", kvBase: "/kv", searchBase: "/search", sectionsBase: "/sections",
    details: { id: "schedules", label: "Schedules", icon: "i-lucide-calendar", description: "Schedules", view: { kind: "definition-catalog", notice: "Schedule metadata" } },
  })
  app.use(router)
  app.provide(ssrContextKey, {})
  try {
    return Reflect.get((app.mount({}).$ as unknown as { setupState: object }).setupState, "runStatus")
  }
  finally {
    app.unmount()
  }
}

async function renderResult(selectedRun?: ConsoleScheduleRunView) {
  const runStatus = await componentRunStatus()
  const app = createSSRApp({
    render: compile(template),
    setup: () => ({
      consoleScheduleRunDescription,
      runStatus,
      canRunSelected: false,
      runningSchedule: undefined,
      runSelectedSchedule: () => {},
      selectedName: "definition:nightly-digest",
      selectedRecord: { fields: [], id: "definition:nightly-digest" },
      selectedRun,
    }),
  })
  app.component("Status", defineComponent({
    props: { label: String, pulse: Boolean, tone: String },
    setup: props => () => h("span", { "data-tone": props.tone }, props.label),
  }))
  for (const name of ["ConsolePropertyList", "UButton"]) {
    app.component(name, defineComponent({ props: { hint: Object }, setup: props => () => h("span", props.hint ? String(Reflect.get(props.hint, "message")) : "") }))
  }
  return renderToString(app)
}

it.each([
  [{ durationMs: 1250, id: "run_1", status: "succeeded" }, "success", "Run succeeded", "1.3s · run_1"],
  [{ error: "mailbox unavailable", status: "failed" }, "error", "Run failed", "mailbox unavailable"],
  [{ error: "Request failed", status: "unavailable" }, "error", "Could not run this Schedule", "Request failed"],
] satisfies [ConsoleScheduleRunView, string, string, string][])("renders a record Schedule result %j as a status", async (run, tone, title, description) => {
  const html = await renderResult(run)
  expect(html).toContain(`data-tone="${tone}"`)
  expect(html).toContain(title)
  expect(html).toContain(description)
  // A status dot reports the result, and no colored alert replaces it.
  expect(html).not.toMatch(/alert/i)
})

it("shows no result before a record runs", async () => {
  const html = await renderResult()
  expect(html).not.toContain("data-tone")
  expect(html).toContain("<article")
})
