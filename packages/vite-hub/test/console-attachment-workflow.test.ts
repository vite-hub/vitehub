import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { defineAgent, startAgentInvocation, workflow } from "@vite-hub/agent"
import { blob } from "../../blob/src/runtime/storage.ts"
import { setBlobRuntimeConfig, setBlobRuntimeStorage } from "../../blob/src/runtime/state.ts"
import { resetOpenWorkflowRuntime, setOpenWorkflowImporter } from "@vite-hub/workflow/runtime/openworkflow"
import { resetWorkflowRuntime, setWorkflowRuntimeConfig } from "@vite-hub/workflow/runtime/state"
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
  const agent = defineAgent({ name: `console-upload-${stage}`, driver: { run: () => "unreachable" }, runtime: workflow(`console-upload-${stage}`) })
  await expect(withConsoleInputMessage("", { files }, (message, onInputHandoff) => startAgentInvocation(
    agent,
    { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() },
    { messages: [message] },
    { onInputHandoff },
  ))).rejects.toThrow()
  expect(dispatch).toHaveBeenCalledTimes(stage === "dispatch" ? 1 : 0)
  const [listError, result] = await blob.list({ prefix: "vitehub-console-attachments/" })
  expect(listError).toBeNull()
  expect(result?.blobs).toHaveLength(stage === "dispatch" ? 2 : 1)
  expect(result?.blobs.map(item => item.pathname)).toContain(`vitehub-console-attachments/${retained.id}`)
})
