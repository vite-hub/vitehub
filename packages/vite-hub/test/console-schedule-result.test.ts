import { readFileSync } from "node:fs"

import { compile, createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { expect, it } from "vitest"

import { consoleStatusValue } from "../src/console/runtime/client/format"
import { consoleScheduleRunDescription } from "../src/console/runtime/client/schedule-run"
import type { ConsoleScheduleRunView } from "../src/console/runtime/client/schedule-run"

const source = readFileSync(new URL("../src/console/runtime/components/console-definitions.vue", import.meta.url), "utf8")
// Render the actual record detail template without the page's navigation and network lifecycle.
const start = source.indexOf('<main v-else-if="selectedRecord"')
const template = source.slice(start, source.indexOf("</main>", start) + "</main>".length)
  .replace('v-else-if="selectedRecord"', 'v-if="selectedRecord"')

async function renderResult(selectedRun?: ConsoleScheduleRunView) {
  const app = createSSRApp({
    render: compile(template),
    setup: () => ({
      consoleScheduleRunDescription,
      // The same mapping as the component's runStatus().
      runStatus: (run: ConsoleScheduleRunView) => ({
        label: run.status === "unavailable" ? "Could not run this Schedule" : `Run ${run.status}`,
        tone: consoleStatusValue(run.status)?.tone ?? "neutral",
      }),
      recordColumns: [],
      records: [],
      sectionDetails: { view: { notice: "Schedule metadata" } },
      selectedName: "definition:nightly-digest",
      selectedRecord: { fields: [], id: "definition:nightly-digest" },
      selectedRun,
    }),
  })
  app.component("ConsoleStatus", defineComponent({
    props: { label: String, pending: Boolean, tone: String },
    setup: props => () => h("span", { "data-tone": props.tone }, props.label),
  }))
  for (const name of ["ConsolePropertyList", "ConsoleSetupHint", "ConsoleValue", "UIcon"]) {
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
  // The notice stays, and no colored alert replaces it.
  expect(html).toContain("Schedule metadata")
})

it("shows no result before a record runs", async () => {
  const html = await renderResult()
  expect(html).not.toContain("data-tone")
  expect(html).toContain("Schedule metadata")
})
