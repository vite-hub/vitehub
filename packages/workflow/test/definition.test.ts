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

  it("discovers server workflow folders as one workflow with ordered steps", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-folder-discovery-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "workflows", "import-products"), { recursive: true })
    await writeFile(join(rootDir, "server", "workflows", "import-products", "02.load.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "workflows", "import-products", "01.extract.ts"), "export default null\n", "utf8")

    expect(discoverWorkflowDefinitions({ mode: "nitro-server-workflows", scanDirs: [join(rootDir, "server")] })).toEqual([
      expect.objectContaining({
        name: "import-products",
        source: "nitro-server-workflows",
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

    expect(() => discoverWorkflowDefinitions({ mode: "nitro-server-workflows", scanDirs: [join(rootDir, "server")] })).toThrow(/Duplicate workflow name "welcome"/)
  })

  it("discovers inline object workflows regardless of property order", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-inline-object-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server"), { recursive: true })
    await writeFile(join(rootDir, "server", "chat.ts"), [
      `import { createWorkflow } from "@vitehub/workflow"`,
      `export const chatReply = createWorkflow<{ email: string; marker?: string }, { ok: boolean }>({`,
      `  handler: async () => ({ ok: true }),`,
      `  name: "chat-reply",`,
      `})`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({
        handler: join(rootDir, "server", "chat.ts"),
        name: "chat-reply",
        source: "inline",
      }),
    ])
  })

  it("discovers inline workflows with function type generics and shorthand handlers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-inline-function-generic-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server"), { recursive: true })
    await writeFile(join(rootDir, "server", "chat.ts"), [
      `import { createWorkflow } from "@vitehub/workflow"`,
      `const handler = async () => "ok"`,
      `export const chatReply = createWorkflow<{ map: (value: string) => boolean }, string>({`,
      `  name: "chat-reply",`,
      `  handler,`,
      `})`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({
        handler: join(rootDir, "server", "chat.ts"),
        name: "chat-reply",
        source: "inline",
      }),
    ])
  })

  it("discovers inline workflows with method-style handlers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-inline-method-handler-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server"), { recursive: true })
    await writeFile(join(rootDir, "server", "chat.ts"), [
      `import { createWorkflow } from "@vitehub/workflow"`,
      `export const chatReply = createWorkflow({`,
      `  name: "chat-reply",`,
      `  async handler() { return { ok: true } },`,
      `})`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({
        handler: join(rootDir, "server", "chat.ts"),
        name: "chat-reply",
        source: "inline",
      }),
    ])
  })

  it("does not discover inline workflows inside comments", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-inline-comments-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server"), { recursive: true })
    await writeFile(join(rootDir, "server", "chat.ts"), [
      `import { createWorkflow } from "@vitehub/workflow"`,
      `// createWorkflow({ name: "line-comment", handler: async () => "ok" })`,
      `/* createWorkflow({ name: "block-comment", handler: async () => "ok" }) */`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([])
  })

  it("ignores options-only createWorkflow calls", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-inline-options-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server"), { recursive: true })
    await writeFile(join(rootDir, "server", "chat.ts"), [
      `import { createWorkflow } from "@vitehub/workflow"`,
      `export const welcome = createWorkflow("welcome", { id: () => "welcome" })`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([])
  })

  it("does not discover inline workflows outside runtime scan roots", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-inline-scope-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "test"), { recursive: true })
    await writeFile(join(rootDir, "test", "fixture.ts"), [
      `import { createWorkflow } from "@vitehub/workflow"`,
      `export const fixture = createWorkflow({ name: "fixture", handler: async () => "ok" })`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([])
  })

  it("keeps root workflow files when the workflows directory has folder markers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-root-flat-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
    await writeFile(join(rootDir, "server", "workflows", "index.ts"), "export default null\n", "utf8")
    await writeFile(join(rootDir, "server", "workflows", "welcome.ts"), "export default null\n", "utf8")

    expect(discoverWorkflowDefinitions({ mode: "nitro-server-workflows", scanDirs: [join(rootDir, "server")] })).toContainEqual(
      expect.objectContaining({ name: "welcome", source: "nitro-server-workflows" }),
    )
  })

  it("prefers inline metadata over suffix discovery for the same file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-inline-suffix-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server"), { recursive: true })
    const file = join(rootDir, "server", "chat.workflow.ts")
    await writeFile(file, [
      `import { createWorkflow } from "@vitehub/workflow"`,
      `export const chat = createWorkflow({ name: "server/workflows/chat", handler: async () => "ok" })`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({
        handler: file,
        name: "server/workflows/chat",
        source: "inline",
      }),
    ])
  })

  it("prefers inline metadata over folder discovery for the same handler", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-inline-folder-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "workflows", "chat"), { recursive: true })
    const file = join(rootDir, "server", "workflows", "chat", "index.ts")
    await writeFile(file, [
      `import { createWorkflow } from "@vitehub/workflow"`,
      `export const chat = createWorkflow({ name: "server/workflows/chat", handler: async () => "ok" })`,
    ].join("\n"), "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({
        handler: file,
        name: "server/workflows/chat",
        source: "inline",
      }),
    ])
  })
})
