import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { defineWorkflow } from "../src/definition.ts"
import { discoverWorkflowDefinitions } from "../src/discovery.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("workflow definitions", () => {
  it("validates handlers", () => {
    expect(() => defineWorkflow(undefined as never)).toThrow(/requires a workflow handler/)
    expect(defineWorkflow(async () => ({ ok: true })).handler).toEqual(expect.any(Function))
  })

  it("discovers Vite suffix and server workflow definitions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-discovery-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
    await writeFile(join(rootDir, "src", "daily.workflow.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "workflows", "welcome.ts"), "export default null\n", "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({ name: "daily", source: "vite-suffix" }),
      expect.objectContaining({ name: "welcome", source: "nitro-server-workflows" }),
    ])
  })
})
