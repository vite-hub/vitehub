import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createOperationRegistry, operationCliPath, runOperation } from "@vite-hub/internal/operations"

import { workflowOperations } from "../src/operations.ts"
import { hubWorkflow } from "../src/vite.ts"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "../src/runtime/state.ts"

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
      ["workflow.start", "write", "workflows"],
    ])
    expect(registry.list().map(operation => operationCliPath(operation))).toEqual([
      { command: "cancel", namespace: "workflow" },
      { command: "get", namespace: "workflow" },
      { command: "resume", namespace: "workflow" },
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
