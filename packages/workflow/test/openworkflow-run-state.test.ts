import { afterEach, beforeEach, expect, it } from "vitest"

import { getWorkflowRun, startWorkflow } from "../src/runtime/client.ts"
import { createWorkflowSteps } from "../src/runtime/execute.ts"
import { resetOpenWorkflowRuntime } from "../src/runtime/openworkflow.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

let failCreateUser = false

beforeEach(() => {
  resetWorkflowRuntime()
  failCreateUser = false
  setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
  // The same shape that the generated registry gives a folder Workflow with two step files.
  setWorkflowRuntimeRegistry({
    "onboard-user": async () => ({
      handler: async (payload: unknown, context: Parameters<typeof createWorkflowSteps>[0]) => {
        const steps = createWorkflowSteps(context, [
          {
            name: "01.create-user.ts",
            run: (input) => {
              if (failCreateUser) throw new Error("The user store is down.")
              return { email: (input as { email: string }).email, id: "user-1" }
            },
          },
          { name: "02.send-welcome.ts", run: input => ({ sent: true, userId: (input as { id: string }).id }) },
        ])
        let value = payload
        for (const step of Object.values(steps)) value = await step(value)
        return value
      },
      options: { rootStep: false },
    }),
  })
})

afterEach(async () => {
  await resetOpenWorkflowRuntime()
})

async function runWorker(): Promise<void> {
  const worker = await createOpenWorkflowWorker()
  await worker.tick()
  await worker.stop()
}

it("reports the payload, times, and steps that OpenWorkflow stores", async () => {
  const startedAt = Date.now()
  const started = await startWorkflow("onboard-user", { email: "ada@example.com" })

  const queued = await getWorkflowRun("onboard-user", started.id)
  expect(queued).toMatchObject({ payload: { email: "ada@example.com" }, status: "queued", steps: [] })
  expect(queued.createdAt).toBeInstanceOf(Date)
  expect(queued.startedAt).toBeUndefined()
  expect(queued.completedAt).toBeUndefined()

  await runWorker()

  const run = await getWorkflowRun("onboard-user", started.id)
  expect(run).toMatchObject({ payload: { email: "ada@example.com" }, status: "completed" })
  expect(run.createdAt?.getTime()).toBeGreaterThanOrEqual(startedAt - 1000)
  expect(run.startedAt).toBeInstanceOf(Date)
  expect(run.completedAt).toBeInstanceOf(Date)
  // OpenWorkflow lists attempts by creation time in milliseconds, so two fast steps can come in either order.
  expect(run.steps).toHaveLength(2)
  expect(run.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ attempt: 1, name: "onboard-user/01.create-user.ts", status: "completed" }),
    expect.objectContaining({ attempt: 1, name: "onboard-user/02.send-welcome.ts", status: "completed" }),
  ]))
  for (const step of run.steps ?? []) {
    expect(step.startedAt).toBeInstanceOf(Date)
    expect(step.completedAt).toBeInstanceOf(Date)
  }
})

it("reports a failed step attempt with its message, without the stack", async () => {
  failCreateUser = true
  const started = await startWorkflow("onboard-user", { email: "ada@example.com" })

  await runWorker()

  const run = await getWorkflowRun("onboard-user", started.id)
  expect(run.steps).toEqual([
    expect.objectContaining({
      attempt: 1,
      error: { message: "The user store is down." },
      name: "onboard-user/01.create-user.ts",
      status: "failed",
    }),
  ])
  expect(JSON.stringify(run.steps)).not.toContain(import.meta.dirname)
})
