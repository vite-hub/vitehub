import { execFile } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { build } from "esbuild"
import { expect, it } from "vitest"

const execFileAsync = promisify(execFile)

it("resolves the startup plugin, dispatches handles and executes folder steps without src", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-package-"))
  const packageRoot = join(import.meta.dirname, "..")
  const installed = join(root, "node_modules/@vite-hub/workflow")
  try {
    await mkdir(installed, { recursive: true })
    await cp(join(packageRoot, "dist"), join(installed, "dist"), { recursive: true })
    await copyFile(join(packageRoot, "package.json"), join(installed, "package.json"))
    // Use the installed dependencies, but copy only the files that Workflow publishes.
    await symlink(join(packageRoot, "node_modules"), join(installed, "node_modules"), "dir")
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    await mkdir(join(root, "server/workflows"), { recursive: true })
    await writeFile(join(root, "server/workflows/demo.mjs"), 'import { createWorkflow } from "@vite-hub/workflow"; export default createWorkflow("demo", async () => "ok")')
    await writeFile(join(root, "server/workflows/named.mjs"), 'import { createWorkflow } from "@vite-hub/workflow"; export const workflow = createWorkflow("named", async () => "ok")')
    await mkdir(join(root, "server/workflows/pipeline"))
    await writeFile(join(root, "server/workflows/pipeline/index.mjs"), 'import { createWorkflow } from "@vite-hub/workflow"; export default createWorkflow("pipeline", async (input, { steps }) => await steps.first(input))')
    await writeFile(join(root, "server/workflows/pipeline/01.first.mjs"), "export default async input => input + 1")
    const script = join(root, "check.mjs")
    await writeFile(script, `
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { hubWorkflow, workflowRuntimeModule } from "@vite-hub/workflow/vite"
import { getWorkflowRun, startWorkflow } from "@vite-hub/workflow"
const root = ${JSON.stringify(root)}
const plugin = hubWorkflow({ sqlite: { path: ":memory:" } }, { hosting: "node-server" })
await plugin.config.handler({ root }, { command: "build", mode: "production" })
await plugin.configResolved({ root })
const startup = await readFile(root + "/.vitehub/nitro/workflow/dev-plugin.mjs", "utf8")
const workerPath = workflowRuntimeModule("openworkflow-worker")
assert.ok(startup.includes(JSON.stringify(workerPath)))
assert.ok(!workerPath.includes("/src/"))
const state = await import(pathToFileURL(workflowRuntimeModule("state")))
const { createOpenWorkflowWorker, installOpenWorkflow } = await import(pathToFileURL(workerPath))
const { resetOpenWorkflowRuntime } = await import(pathToFileURL(workerPath.replace("openworkflow-worker.js", "openworkflow.js")))
state.setWorkflowRuntimeConfig({ provider: "openworkflow", sqlite: { path: ":memory:" } })
const { default: registry } = await import("./.vitehub/nitro/workflow/dev-registry.mjs")
state.setWorkflowRuntimeRegistry(registry)
const hooks = []
const app = { hooks: { hook: (_name, callback) => hooks.push(callback) } }
try {
  const worker = await createOpenWorkflowWorker()
  try {
    const run = await startWorkflow("pipeline", 1)
    assert.equal(await worker.tick(), 1)
    await worker.stop()
    const completed = await getWorkflowRun("pipeline", run.id)
    assert.equal(completed.status, "completed", JSON.stringify(completed))
    assert.equal(await completed.result.json(), 2)
    assert.equal((await state.loadWorkflowDefinition("pipeline")).options.rootStep, false)
  } finally {
    await worker.stop()
  }
  assert.equal(await installOpenWorkflow(app), true)
  for (const name of ["demo", "named"]) {
    const run = await startWorkflow(name)
    assert.equal(run.status, "queued")
  }
} finally {
  for (const hook of hooks) await hook()
  await resetOpenWorkflowRuntime()
}
console.log("packaged worker and dispatch passed")
`)
    const result = await execFileAsync(process.execPath, [script], { timeout: 20_000 })
    expect(result.stdout).toContain("packaged worker and dispatch passed")
    await build({
      absWorkingDir: root,
      entryPoints: [join(root, ".vitehub/nitro/workflow/dev-plugin.mjs")],
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
    })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
