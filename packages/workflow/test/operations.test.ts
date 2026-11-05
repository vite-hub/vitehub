import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createOperationRegistry, operationCliPath, runOperation } from "@vite-hub/internal/operations"

import { workflowOperations } from "../src/operations.ts"
import { createWorkflowSteps } from "../src/runtime/execute.ts"
import { hubWorkflow } from "../src/vite.ts"
import { enableWorkflowDevRuns, resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

import type { WorkflowExecutionContext } from "../src/types.ts"

const registry = createOperationRegistry([{ operations: workflowOperations }])
const access = { mode: "local", sections: "all" } as const

async function call(name: string, input: unknown, sections: "all" | readonly string[] = "all") {
  return await runOperation(registry, name, input, { access: { ...access, sections }, surface: "cli", user: null })
}

beforeEach(() => {
  resetWorkflowRuntime()
  setWorkflowRuntimeConfig({ provider: "vercel" })
  setWorkflowRuntimeRegistry({
    welcome: async () => ({ default: { handler: async ({ payload }) => ({ reply: String((payload as { name?: string } | undefined)?.name ?? "nobody").toUpperCase() }) } }),
  })
})

afterEach(() => resetWorkflowRuntime())

describe("workflow operations", () => {
  it("are the workflow commands of the Workflows Console section", () => {
    expect(registry.list().map(operation => [operation.name, operation.kind, operation.section])).toEqual([
      ["workflow.cancel", "destructive", "workflows"],
      ["workflow.get", "read", "workflows"],
      ["workflow.resume", "write", "workflows"],
      ["workflow.runs-list", "read", "workflows"],
      ["workflow.runs-show", "read", "workflows"],
      ["workflow.start", "write", "workflows"],
    ])
    expect(registry.list().map(operation => operationCliPath(operation))).toEqual([
      { command: "cancel", namespace: "workflow" },
      { command: "get", namespace: "workflow" },
      { command: "resume", namespace: "workflow" },
      { command: "runs list", namespace: "workflow" },
      { command: "runs show", namespace: "workflow" },
      { command: "start", namespace: "workflow" },
    ])
  })

  it("are contributed by the Workflow Vite plugin, which no longer adds a dev endpoint", async () => {
    const plugin = hubWorkflow()
    const [entry] = plugin.vitehub?.operations ?? []
    expect(entry).toMatchObject({ export: "workflowOperations", module: "@vite-hub/workflow/operations" })
    expect(await entry?.load?.()).toBe(workflowOperations)
    expect(plugin.vitehub).not.toHaveProperty("cli")
    const nitro: Record<string, unknown> = {}
    const config = { nitro, root: process.cwd() }
    const hook = plugin.config
    await (typeof hook === "function" ? hook : hook?.handler)?.call({} as never, config as never, { command: "serve", mode: "development" })
    expect(JSON.stringify(config.nitro)).not.toContain("/_vitehub/workflow/dev")
    expect(JSON.stringify(config.nitro)).not.toContain("dev-handler")
  })

  it("starts a run and reads it back without naming the Workflow", async () => {
    const started = await call("workflow.start", { payload: { name: "ada" }, workflow: "welcome" })
    expect(started).toMatchObject({ ok: true, value: { run: { provider: "vercel", workflow: "welcome" } } })
    if (!started.ok) throw new Error("start failed")
    const { id } = (started.value as { run: { id: string } }).run
    await expect.poll(async () => await call("workflow.get", { runId: id })).toMatchObject({
      ok: true,
      value: { run: { id, result: { reply: "ADA" }, status: "completed", workflow: "welcome" } },
    })
  })

  it("redacts credentials in the result of a run", async () => {
    setWorkflowRuntimeRegistry({
      leaky: async () => ({ default: { handler: async () => ({ token: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789" }) } }),
    })
    const started = await call("workflow.start", { workflow: "leaky" })
    if (!started.ok) throw new Error("start failed")
    const { id } = (started.value as { run: { id: string } }).run
    await expect.poll(async () => JSON.stringify(await call("workflow.get", { runId: id }))).toContain("completed")
    expect(JSON.stringify(await call("workflow.get", { runId: id }))).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123456789")
  })

  it("lists and shows the runs that `vite dev` recorded, with steps, result, and error", async () => {
    enableWorkflowDevRuns()
    // A folder Workflow: each step file runs through the step runner.
    const folder = (fail: boolean) => async () => ({
      default: {
        handler: async (context: WorkflowExecutionContext) => {
          const steps = createWorkflowSteps(context, [
            { name: "01-load.ts", run: async () => ({ user: "ada" }) },
            { name: "02-send.ts", run: async () => { if (fail) throw new Error("SMTP rejected Bearer abc.def.ghi"); return { sent: true } } },
          ])
          await steps.load!(undefined)
          return await steps.send!(undefined)
        },
        options: { rootStep: false },
      },
    })
    setWorkflowRuntimeRegistry({ broken: folder(true), onboard: folder(false) })

    const ok = await call("workflow.start", { workflow: "onboard" })
    const failed = await call("workflow.start", { workflow: "broken" })
    if (!ok.ok || !failed.ok) throw new Error("start failed")
    const okId = (ok.value as { run: { id: string } }).run.id
    const failedId = (failed.value as { run: { id: string } }).run.id

    await expect.poll(async () => await call("workflow.runs-show", { id: okId })).toMatchObject({
      ok: true,
      value: {
        run: {
          id: okId,
          result: { sent: true },
          status: "completed",
          steps: [
            { name: "onboard/01-load.ts", output: { user: "ada" }, status: "completed" },
            { name: "onboard/02-send.ts", output: { sent: true }, status: "completed" },
          ],
          workflow: "onboard",
        },
      },
    })
    await expect.poll(async () => await call("workflow.runs-show", { id: failedId })).toMatchObject({
      ok: true,
      value: { run: { error: { message: expect.stringContaining("SMTP rejected") }, status: "failed", steps: [{ status: "completed" }, { error: { message: expect.stringContaining("SMTP rejected") }, status: "failed" }] } },
    })
    expect(JSON.stringify(await call("workflow.runs-show", { id: failedId }))).not.toContain("abc.def.ghi")

    expect(await call("workflow.runs-list", {})).toMatchObject({ ok: true, value: { runs: [{ id: failedId, stepCount: 2 }, { id: okId, stepCount: 2 }] } })
    expect(await call("workflow.runs-list", { status: "failed" })).toMatchObject({ ok: true, value: { runs: [{ id: failedId }] } })
    expect(await call("workflow.runs-list", { limit: 1, workflow: "onboard" })).toMatchObject({ ok: true, value: { runs: [{ id: okId }] } })
    expect(await call("workflow.runs-show", { id: "wrun_missing" })).toMatchObject({ code: "WORKFLOW_RUN_NOT_FOUND", fix: expect.any(String), ok: false, status: 404 })
    expect(await call("workflow.runs-list", {}, ["workflows:read"])).toMatchObject({ ok: true })
  })

  it("says that a runtime outside `vite dev` keeps no run history", async () => {
    await call("workflow.start", { payload: { name: "ada" }, workflow: "welcome" })
    expect(await call("workflow.runs-list", {})).toMatchObject({ code: "WORKFLOW_RUNS_UNAVAILABLE", fix: expect.stringContaining("vite dev"), ok: false, status: 409 })
    expect(await call("workflow.runs-show", { id: "wrun_1" })).toMatchObject({ code: "WORKFLOW_RUNS_UNAVAILABLE", ok: false, status: 409 })
  })

  it("rejects an unknown Workflow with the names that exist", async () => {
    expect(await call("workflow.start", { workflow: "missing" })).toMatchObject({
      code: "WORKFLOW_DEFINITION_NOT_FOUND",
      message: expect.stringContaining("Available Workflows: welcome."),
      ok: false,
      status: 404,
    })
  })

  it("asks for the Workflow name of a run the runtime did not start", async () => {
    expect(await call("workflow.get", { runId: "wrun_elsewhere" })).toMatchObject({ code: "WORKFLOW_RUN_UNKNOWN", ok: false, status: 400 })
  })

  it("fails with WORKFLOW_DISABLED when the app disables Workflow", async () => {
    setWorkflowRuntimeConfig(false)
    expect(await call("workflow.start", { workflow: "welcome" })).toMatchObject({ code: "WORKFLOW_DISABLED", fix: expect.any(String), ok: false, status: 409 })
  })

  it("reports operations that a provider does not support", async () => {
    setWorkflowRuntimeConfig({ provider: "cloudflare" } as never)
    expect(await call("workflow.cancel", { runId: "wrun_1", workflow: "welcome" })).toMatchObject({ code: "WORKFLOW_OPERATION_UNSUPPORTED", ok: false, status: 501 })
    expect(await call("workflow.resume", { token: "token" })).toMatchObject({ code: "WORKFLOW_OPERATION_UNSUPPORTED", ok: false, status: 501 })
  })

  it("lets a read-only grant read runs but not start, cancel, or resume", async () => {
    const readOnly = ["workflows:read"] as const
    expect(await call("workflow.get", { runId: "wrun_1", workflow: "welcome" }, readOnly)).not.toMatchObject({ status: 403 })
    for (const [name, input] of [["workflow.start", { workflow: "welcome" }], ["workflow.cancel", { runId: "wrun_1", workflow: "welcome" }], ["workflow.resume", { token: "token" }]] as const) {
      expect(await call(name, input, readOnly)).toMatchObject({ code: "INTERNAL_R0023", ok: false, status: 403 })
    }
  })

  it("is not reachable with a grant of another section", async () => {
    expect(await call("workflow.start", { workflow: "welcome" }, ["kv"])).toMatchObject({ ok: false, status: 403 })
  })

  it("rejects input that is not an object with a Workflow name", async () => {
    expect(await call("workflow.start", {})).toMatchObject({ ok: false, status: 400 })
    expect(await call("workflow.start", { workflow: " " })).toMatchObject({ ok: false, status: 400 })
  })
})
