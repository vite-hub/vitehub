import assert from "node:assert/strict"

import { defineAgent, runAgent, workflow as agentWorkflow } from "vite-hub/agent"
import { blob as blobCapability } from "vite-hub/agent/capabilities"
import { env } from "vite-hub/env"
import { defineWorkflow, getWorkflowRun } from "vite-hub/workflow"
import { createWorkspaceTools, defineWorkspace } from "vite-hub/workspace"

const serverBundle = await import("./dist/server/server-entry.js")
assert.equal(typeof serverBundle.authHandler, "function")
assert.deepEqual(serverBundle.scheduleNames, ["agent/echo", "heartbeat"])

const values = new Map()
const agent = defineAgent({
  runtime: false,
  driver: {
    run({ prompt }) {
      return { text: `runtime:${String(prompt)}` }
    },
  },
})
const agentResult = await runAgent(agent, {
  memo(key, create) {
    if (!values.has(key)) values.set(key, create())
    return values.get(key)
  },
  runtime: "vite",
  waitUntil(task) {
    void task.catch(() => {})
  },
}, { prompt: "smoke" })

assert.deepEqual(agentResult, { text: "runtime:smoke" })

const crossOwnerAgent = defineAgent({
  capabilities: [blobCapability()],
  runtime: false,
  driver: {
    async run({ tools }) {
      assert.equal(typeof tools.blob_read?.execute, "function")
      const listing = await tools.blob_read.execute({ operation: "list", prefix: "smoke/" })
      assert.ok(Array.isArray(listing.blobs))
      assert.deepEqual(listing.blobs, [])
      return { text: "blob owner edge ok" }
    },
  },
})
const crossOwnerResult = await runAgent(crossOwnerAgent, {
  memo(key, create) {
    if (!values.has(key)) values.set(key, create())
    return values.get(key)
  },
  runtime: "vite",
  waitUntil(task) {
    void task.catch(() => {})
  },
}, { prompt: "owner edge" })
assert.deepEqual(crossOwnerResult, { text: "blob owner edge ok" })

const workspaceAgent = defineAgent({
  runtime: false,
  workspace: { mode: "write", store: { provider: "memory" } },
  driver: {
    async run({ workspace }) {
      await workspace.fs.writeFile("owner-edge.txt", "workspace owner edge ok")
      return await workspace.fs.readFile("owner-edge.txt")
    },
  },
})
const workspaceAgentResult = await runAgent(workspaceAgent, {
  memo(key, create) {
    if (!values.has(key)) values.set(key, create())
    return values.get(key)
  },
  runtime: "vite",
  waitUntil(task) {
    void task.catch(() => {})
  },
}, { prompt: "owner edge" })
assert.equal(workspaceAgentResult, "workspace owner edge ok")

const workflowTasks = []
const workflowAgent = defineAgent({
  runtime: agentWorkflow("consumer-workflow-agent"),
  driver: {
    run({ prompt }) {
      return `workflow owner edge:${String(prompt)}`
    },
  },
})
const workflowAgentRun = await runAgent(workflowAgent, {
  memo(key, create) {
    if (!values.has(key)) values.set(key, create())
    return values.get(key)
  },
  runtime: "vite",
  waitUntil(task) {
    workflowTasks.push(task)
  },
}, { prompt: "ok" })
await Promise.all(workflowTasks)
assert.equal(typeof workflowAgentRun.id, "string")
const completedWorkflowAgentRun = await getWorkflowRun("consumer-workflow-agent", workflowAgentRun.id)
assert.equal(completedWorkflowAgentRun.status, "completed")
assert.equal(completedWorkflowAgentRun.result, "workflow owner edge:ok")

const declaration = env({ default: "runtime" })
assert.equal(declaration.kind, "env-variable")
assert.equal(declaration.default, "runtime")

const workspace = defineWorkspace({ store: { provider: "memory" } })
assert.equal(workspace.store?.provider, "memory")

const workspaceTools = createWorkspaceTools({})
const pwd = await workspaceTools.shell.execute({ command: "pwd" })
assert.equal(pwd.exitCode, 0)
assert.equal(pwd.stdout, "/workspace\n")

const workflow = defineWorkflow(async ({ payload }) => ({ marker: payload.marker }))
assert.deepEqual(await workflow.handler({ payload: { marker: "runtime" } }), { marker: "runtime" })

console.log("vite-hub runtime smoke ok")
