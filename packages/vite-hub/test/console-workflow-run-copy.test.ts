// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils"
import { expect, it, vi } from "vitest"

import type { ConsoleWorkflowRunView } from "../src/console/runtime/client/workflow"

const mocks = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock("../src/console/runtime/client/workflow", async original => ({
  ...await original<typeof import("../src/console/runtime/client/workflow")>(),
  startConsoleWorkflow: mocks.start,
}))

import WorkflowActions from "../src/console/runtime/components/console-workflow-actions.vue"

async function startRun(run: ConsoleWorkflowRunView) {
  mocks.start.mockResolvedValueOnce(run)
  const button = { inheritAttrs: false, props: ["label"], emits: ["click"], template: "<button v-bind=\"$attrs\" @click=\"$emit('click')\">{{ label }}</button>" }
  const wrapper = mount(WorkflowActions, {
    props: { base: "/_vitehub/api/workflow", canResume: false, canStart: true, workflow: run.workflow },
    global: { stubs: { CopyButton: { template: "<button />" }, UButton: button, UTextarea: true, UTooltip: { template: "<slot />" } } },
  })
  await wrapper.findAll("button").find(button => button.text() === "Start")!.trigger("click")
  await flushPromises()
  return wrapper
}

it("offers to copy the run ID and the result of a finished run", async () => {
  const wrapper = await startRun({ id: "wrun_1", provider: "memory", result: "{\n  \"ok\": true\n}", status: "succeeded", workflow: "release" })
  expect(wrapper.find("[aria-label=\"Copy run ID\"]").exists()).toBe(true)
  expect(wrapper.find("[aria-label=\"Copy result\"]").exists()).toBe(true)
})

it("offers no result copy while a run has no result", async () => {
  const wrapper = await startRun({ id: "wrun_2", provider: "memory", status: "running", workflow: "release" })
  expect(wrapper.find("[aria-label=\"Copy run ID\"]").exists()).toBe(true)
  expect(wrapper.find("[aria-label=\"Copy result\"]").exists()).toBe(false)
})
