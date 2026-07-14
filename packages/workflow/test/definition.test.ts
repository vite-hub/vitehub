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
      expect.objectContaining({ name: "welcome", source: "server-workflows" }),
    ])
  })

  it("discovers server workflow folders as one workflow with ordered steps", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-folder-discovery-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "workflows", "import-products"), { recursive: true })
    await writeFile(join(rootDir, "server", "workflows", "import-products", "02.load.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "workflows", "import-products", "01.extract.ts"), "export default null\n", "utf8")

    expect(discoverWorkflowDefinitions({ mode: "server-workflows", scanDirs: [join(rootDir, "server")] })).toEqual([
      expect.objectContaining({
        name: "import-products",
        source: "server-workflows",
        steps: [
          join(rootDir, "server", "workflows", "import-products", "01.extract.ts"),
          join(rootDir, "server", "workflows", "import-products", "02.load.ts"),
        ],
      }),
    ])
  })

  it("fails when flat and folder workflows use the same name", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-folder-duplicate-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "workflows", "welcome"), { recursive: true })
    await writeFile(join(rootDir, "server", "workflows", "welcome.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "workflows", "welcome", "01.step.ts"), "export default null\n", "utf8")

    expect(() => discoverWorkflowDefinitions({ mode: "server-workflows", scanDirs: [join(rootDir, "server")] })).toThrow(/Duplicate workflow name "welcome"/)
  })

  it("does not discover createWorkflow calls outside workflow definition locations", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-runtime-helper-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server"), { recursive: true })
    await writeFile(join(rootDir, "server", "chat.ts"), [
      `import { createWorkflow } from "@vite-hub/workflow"`,
      `export const chatReply = createWorkflow({`,
      `  name: "chat-reply",`,
      `  handler: async () => ({ ok: true }),`,
      `})`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([])
  })

  it("discovers nested file Agent workflows inside folder Agents without discovering helpers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-workflow-nested-file-"))
    tempDirs.push(rootDir)
    const agentDir = join(rootDir, "server", "agents", "team")
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, "agent.ts"), "export default defineAgent({ runtime: workflow() })\n", "utf8")
    await writeFile(join(agentDir, "review.ts"), "export default defineAgent({ runtime: workflow() })\n", "utf8")
    await writeFile(join(agentDir, "config.ts"), "export default defineAgent({ runtime: workflow() })\n", "utf8")
    await writeFile(join(agentDir, "helper.ts"), "export const helper = true\n", "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({ name: "team", source: "agent-workflow" }),
      expect.objectContaining({ name: "team/review", source: "agent-workflow" }),
    ])
  })

  it("keeps root workflow files when the workflows directory has folder markers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-root-flat-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
    await writeFile(join(rootDir, "server", "workflows", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "workflows", "welcome.ts"), "export default null\n", "utf8")

    expect(discoverWorkflowDefinitions({ mode: "server-workflows", scanDirs: [join(rootDir, "server")] })).toContainEqual(
      expect.objectContaining({ name: "welcome", source: "server-workflows" }),
    )
  })

  it("uses suffix identity even when a workflow file calls createWorkflow with another name", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-suffix-identity-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server"), { recursive: true })
    const file = join(rootDir, "server", "chat.workflow.ts")
    await writeFile(file, [
      `import { createWorkflow } from "@vite-hub/workflow"`,
      `export const chat = createWorkflow({ name: "server/workflows/chat", handler: async () => "ok" })`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({
        handler: file,
        name: "server/chat",
        source: "vite-suffix",
      }),
    ])
  })

  it("uses folder identity even when the folder index calls createWorkflow with another name", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-folder-identity-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "workflows", "chat"), { recursive: true })
    const file = join(rootDir, "server", "workflows", "chat", "index.ts")
    const step = join(rootDir, "server", "workflows", "chat", "01.reply.ts")
    await writeFile(file, [
      `import { createWorkflow } from "@vite-hub/workflow"`,
      `export const chat = createWorkflow({ name: "server/workflows/chat", handler: async () => "ok" })`,
    ].join("\n"), "utf8")
    await writeFile(step, "export default null\n", "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({
        handler: file,
        name: "chat",
        source: "server-workflows",
        steps: [step],
      }),
    ])
  })
})
