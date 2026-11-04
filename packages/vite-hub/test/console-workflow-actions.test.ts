import { createSSRApp } from "vue"
import { renderToString } from "vue/server-renderer"
import { expect, it } from "vitest"

import WorkflowActions from "../src/console/runtime/components/console-workflow-actions.vue"

const props = { base: "/api/_vitehub/console/workflow", workflow: "release" }

it("renders nothing without Start, Resume, or runs, so the Definition page keeps its spacing", async () => {
  expect(await renderToString(createSSRApp(WorkflowActions, { ...props, canResume: false, canStart: false }))).toBe("<!---->")
})

it("renders the Start form when the access can start a run", async () => {
  expect(await renderToString(createSSRApp(WorkflowActions, { ...props, canResume: false, canStart: true }))).toContain("Start a run")
})
