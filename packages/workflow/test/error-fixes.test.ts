import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

import { expect, it, onTestFinished } from "vitest"
import { resolve } from "pathe"

import { defineWorkflow } from "../src/definition.ts"
import { workflowErrorDiagnostics } from "../src/error-diagnostics.ts"
import { hubWorkflow } from "../src/vite.ts"

import type { WorkflowOptions } from "../src/types.ts"

const fixedCodes = [
  "WORKFLOW_C0001",
  "WORKFLOW_C0002",
  "WORKFLOW_C0003",
  "WORKFLOW_C0004",
  "WORKFLOW_C0005",
  "WORKFLOW_C0006",
  "WORKFLOW_C0007",
  "WORKFLOW_C0008",
  "WORKFLOW_C0009",
  "WORKFLOW_C0010",
  "WORKFLOW_C0011",
  "WORKFLOW_C0012",
  "WORKFLOW_C0013",
  "WORKFLOW_C0014",
  "WORKFLOW_C0015",
  "WORKFLOW_C0016",
  "WORKFLOW_C0017",
] as const

async function buildConfig(options: WorkflowOptions, hosting = "node-server") {
  const root = await mkdtemp(resolve(tmpdir(), "vitehub-workflow-error-fixes-"))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const plugin = hubWorkflow(options, { hosting })
  const config = (plugin.config as { handler: (config: unknown, env: { command: string }) => Promise<unknown> }).handler
  return config({ root }, { command: "build" })
}

it("gives each Workflow definition and config code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = workflowErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/workflows/diagnostics/${code.toLowerCase()}`)
  }
})

it("lists the drivers in the fix of an unknown driver", async () => {
  await expect(buildConfig({ driver: "temporal" } as never)).rejects.toMatchObject({
    code: "WORKFLOW_C0009",
    fix: expect.stringContaining("`workflow.driver`"),
    message: "Unknown `workflow.driver`: \"temporal\". Expected \"cloudflare\", \"openworkflow\", or \"vercel\".",
  })
})

it("names both storage options in the fix of two OpenWorkflow stores", async () => {
  await expect(buildConfig({ postgres: { url: "postgres://localhost/app" }, driver: "openworkflow", sqlite: { path: ".vitehub/data/workflow.sqlite" } })).rejects.toMatchObject({
    code: "WORKFLOW_C0012",
    fix: expect.stringContaining("`workflow.postgres.url` and `workflow.sqlite.path`"),
  })
})

it("names the one-object form in the fix of the removed defineWorkflow(name, handler)", () => {
  // SAFETY: The test intentionally crosses the public type boundary to verify the removed form.
  expect(() => defineWorkflow("onboard-user" as never, (async () => {}) as never)).toThrow(expect.objectContaining({
    code: "WORKFLOW_C0015",
    fix: expect.stringContaining("defineWorkflow({ handler, native })"),
  }))
})
