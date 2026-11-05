import { readFileSync } from "node:fs"

import { compile, createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { expect, it } from "vitest"

import type { ConsoleWorkflowRunView } from "../src/console/runtime/client/workflow"

const source = readFileSync(new URL("../src/console/runtime/components/console-workflow-actions.vue", import.meta.url), "utf8")
// Render the actual run list without the start and resume forms.
const start = source.indexOf('<section v-if="workflowRuns.length"')
const template = source.slice(start, source.indexOf("</section>", start) + "</section>".length)

async function renderRuns(run: ConsoleWorkflowRunView): Promise<string> {
  const app = createSSRApp({
    render: compile(template),
    setup: () => ({
      busyRun: undefined,
      copy: () => {},
      isConsoleWorkflowRunActive: () => false,
      refresh: () => {},
      statusOf: () => ({ label: "Succeeded", tone: "success" }),
      workflowRuns: [run],
    }),
  })
  app.component("UButton", defineComponent({ props: { ariaLabel: String }, setup: props => () => h("button", { "aria-label": props.ariaLabel }) }))
  for (const name of ["ConsoleStatus", "UTooltip"]) {
    app.component(name, defineComponent({ setup: (_props, { slots }) => () => slots.default?.() }))
  }
  return renderToString(app)
}

it("offers to copy the run ID and the result of a finished run", async () => {
  const html = await renderRuns({ id: "wrun_1", provider: "memory", result: "{\n  \"ok\": true\n}", status: "succeeded", workflow: "release" })
  expect(html).toContain("aria-label=\"Copy run ID\"")
  expect(html).toContain("aria-label=\"Copy result\"")
})

it("offers no result copy while a run has no result", async () => {
  const html = await renderRuns({ id: "wrun_2", provider: "memory", status: "running", workflow: "release" })
  expect(html).toContain("aria-label=\"Copy run ID\"")
  expect(html).not.toContain("Copy result")
})
