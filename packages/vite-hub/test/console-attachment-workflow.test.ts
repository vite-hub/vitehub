import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { agentWorkflow, defineAgent, startAgentInvocation } from "@vite-hub/agent"
import { startWorkflow } from "@vite-hub/workflow"
import { blob } from "../../blob/src/runtime/storage.ts"
import { setBlobRuntimeConfig, setBlobRuntimeStorage } from "../../blob/src/runtime/state.ts"
import { resetOpenWorkflowRuntime, setOpenWorkflowImporter } from "@vite-hub/workflow/runtime/openworkflow"
import { resetWorkflowRuntime, runWithWorkflowRuntimeEvent, setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry } from "@vite-hub/workflow/runtime/state"
import { installConsoleBlob } from "../src/console/runtime/server/blob.ts"
import { storeConsoleInputMessage, withConsoleInputMessage } from "../src/console/runtime/server/attachments.ts"

const dirs: string[] = []
afterEach(async () => {
  await resetOpenWorkflowRuntime()
  resetWorkflowRuntime()
  setBlobRuntimeStorage(undefined)
  setBlobRuntimeConfig(undefined)
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

it.each(["import", "connect", "registration", "dispatch"] as const)("rolls back Console images only before Workflow dispatch: %s", async (stage) => {
  const base = await mkdtemp(join(tmpdir(), "console-workflow-input-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base }, serve: { route: "/files/", store: "default", publicBaseUrl: "https://example.test" } })
  installConsoleBlob(base, blob)
  const files = [{ url: "data:image/png;base64,YQ==", filename: "test.png" }]
  const retained = (await storeConsoleInputMessage("", { files })).parts[0]!
  const failure = new Error("Workflow startup failed")
  const dispatch = vi.fn(async () => { throw failure })
  const connect = vi.fn(() => {
    if (stage === "connect") throw failure
    return { stop: vi.fn() }
  })
  class OpenWorkflow {
    defineWorkflow() {
      if (stage === "registration") throw failure
      return { run: dispatch }
    }
  }
  setOpenWorkflowImporter(async (specifier) => {
    if (stage === "import") throw failure
    // SAFETY: This fixture implements only the runtime construction and rejected submission used here.
    if (specifier === "openworkflow") return { OpenWorkflow } as never
    // SAFETY: The in-memory backend is never queried because provider submission always rejects.
    if (specifier === "openworkflow/sqlite") return { BackendSqlite: { connect } } as never
    throw new Error(`Unexpected import: ${specifier}`)
  })
  setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
  const name = `console-upload-${stage}`
  setWorkflowRuntimeRegistry({ [name]: async () => ({ default: { handler: async () => "unreachable" } }) })
  await expect(withConsoleInputMessage("", { files }, (message, onInputHandoff) => runWithWorkflowRuntimeEvent(
    { onDispatch: onInputHandoff },
    () => startWorkflow(name, { messages: [message] }),
  ))).rejects.toThrow()
  expect(dispatch).toHaveBeenCalledTimes(stage === "dispatch" ? 1 : 0)
  const [listError, result] = await blob.list({ prefix: "_vitehub/console/attachments/" })
  expect(listError).toBeUndefined()
  expect(result?.blobs).toHaveLength(stage === "dispatch" ? 2 : 1)
  expect(result?.blobs.map(item => item.pathname)).toContain(`_vitehub/console/attachments/${retained.id}`)
})

it("keeps Console images when an Agent Workflow executes inline on OpenWorkflow", async () => {
  const base = await mkdtemp(join(tmpdir(), "console-workflow-inline-")); dirs.push(base)
  setBlobRuntimeConfig({ store: { driver: "fs", base }, serve: { route: "/files/", store: "default", publicBaseUrl: "https://example.test" } })
  installConsoleBlob(base, blob)
  const importer = vi.fn(async () => { throw new Error("OpenWorkflow must not load for inline Agent Workflows") })
  setOpenWorkflowImporter(importer)
  setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
  const run = vi.fn(() => "done")
  const agent = defineAgent({ name: "console-inline-upload", driver: { run }, runtime: agentWorkflow("console-inline-upload") })
  const controller = await withConsoleInputMessage("", { files: [{ url: "data:image/png;base64,YQ==", filename: "test.png" }] }, (message, onInputHandoff) => startAgentInvocation(
    agent,
    { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() },
    { messages: [message] },
    { onInputHandoff },
  ))
  await vi.waitFor(async () => expect(await controller.inspect()).toMatchObject({ outcome: "available", invocation: { status: "completed" } }))
  expect(run).toHaveBeenCalledOnce()
  expect(importer).not.toHaveBeenCalled()
  const [listError, result] = await blob.list({ prefix: "_vitehub/console/attachments/" })
  expect(listError).toBeUndefined()
  expect(result?.blobs).toHaveLength(1)
})
