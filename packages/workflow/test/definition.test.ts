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

  it("registers optional native durable entries", () => {
    const handler = async () => ({ inline: true })
    const native = async () => ({ inline: false })

    expect(defineWorkflow(handler, { native })).toEqual({
      handler,
      options: { native },
    })
    expect(() => defineWorkflow(handler, { native: "invalid" as never })).toThrow(/native entry/)
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
      expect.objectContaining({ name: "team/config", source: "agent-workflow" }),
      expect.objectContaining({ name: "team/review", source: "agent-workflow" }),
    ])
  })

  it("discovers Agent Definitions as workflows by default and honors runtime overrides", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-workflow-discovery-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "inline"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "inline", "workspace"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "inline", "workspace", "src"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "named"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "mentioned"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "typed-inline"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "typed-named"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "wrapped"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "wrapped-index", "definition"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "dynamic"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "imported"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "imported-comment"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "wrapped-inline"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "index-folder", "workspace", "src"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "team"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "team", "skills", "helper"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "variable-inline"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "variable-typed"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "variable-function-typed"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "aliased"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "options-inline"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "block-comment"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "shorthand-inline"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "shorthand-named"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "js-wrapper"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "trailing-comment"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "workspace"), { recursive: true })
    await mkdir(join(rootDir, "server", "agents", "external-wrapper"), { recursive: true })
    await writeFile(join(rootDir, "src", "support.agent.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "inline", "agent.ts"), "export default defineAgent({ runtime: false, driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "inline", "workspace", "source.ts"), "export const runtime = false\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "inline", "workspace", "src", "agent.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "named", "agent.ts"), "const helper = defineAgent({ runtime: false, driver: { run } })\nexport default defineAgent({ runtime: workflow('custom-name'), driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "mentioned", "agent.ts"), "export default defineAgent({ driver: { run: () => 'runtime: false' }, metadata: { runtime: false } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "typed-inline", "agent.ts"), "export default defineAgent<Runtime>({ runtime: /* inline */ false as const, driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "typed-named", "agent.ts"), "import { defineAgent } from '@vite-hub/agent'\nexport default defineAgent<{ handler: () => string }, Options>({ runtime: /* provider */ workflow(/* stable */ 'typed-custom'), driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "wrapped", "agent.ts"), "export { default } from './definition'\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "wrapped", "definition.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "wrapped-index", "agent.ts"), "export { default } from './definition'\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "wrapped-index", "definition", "index.ts"), "export default defineAgent({ runtime: workflow('wrapped-custom'), driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "dynamic", "agent.ts"), "export default defineAgent(createOptions())\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "imported", "agent.ts"), "import reviewAgent from './definition'\nexport default reviewAgent\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "imported", "definition.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "imported-comment", "agent.ts"), "// import reviewAgent from './old'\nimport reviewAgent from './definition'\nexport default reviewAgent\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "imported-comment", "old.ts"), "export default defineAgent({ runtime: false, driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "imported-comment", "definition.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "wrapped-inline", "agent.ts"), "export { default } from './definition'\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "wrapped-inline", "definition.ts"), "export default defineAgent({ runtime: false, driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "index-folder", "index.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "index-folder", "workspace", "src", "agent.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "team", "agent.ts"), "export { default } from './review'\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "team", "index.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "team", "review.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "team", "helper.ts"), "export default { driver: { run } }\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "team", "commented-wrapper.ts"), "// export { default } from './agent'\nexport const example = true\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "team", "skills", "helper", "agent.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "variable-inline", "agent.ts"), "const supportAgent = defineAgent({ runtime: false, driver: { run } })\nexport default supportAgent\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "variable-typed", "agent.ts"), "const jobsAgent: AgentDefinition<{ region: string; token: string }> = defineAgent({ runtime: workflow('typed-variable'), driver: { run } })\nexport default jobsAgent\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "variable-function-typed", "agent.ts"), "const jobsAgent: AgentDefinition<{ handler: () => string }> = defineAgent({ runtime: false, driver: { run } })\nexport default jobsAgent\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "aliased", "agent.ts"), "import { defineAgent as agent } from '@vite-hub/agent'\nexport default agent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "options-inline", "agent.ts"), "const options = { runtime: false, driver: { run } }\nexport default defineAgent(options)\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "block-comment", "agent.ts"), "export default defineAgent({ runtime: workflow('billing') /* hosted */, driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "shorthand-inline", "agent.ts"), "const runtime = false as const\nexport default defineAgent({ runtime, driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "shorthand-named", "agent.ts"), "const runtime = workflow('shorthand-custom')\nexport default defineAgent({ runtime, driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "js-wrapper", "agent.ts"), "export { default } from './definition.js'\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "js-wrapper", "definition.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "trailing-comment", "agent.ts"), "export default defineAgent({ runtime: workflow('commented-name') // hosted workflow\n, driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "workspace", "foo.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "external.ts"), "export default defineAgent({ driver: { run } })\n", "utf8")
    await writeFile(join(rootDir, "server", "agents", "external-wrapper", "agent.ts"), "export { default } from '../external'\n", "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({ name: "aliased", source: "agent-workflow" }),
      expect.objectContaining({ agentIdentity: "block-comment", name: "billing", source: "agent-workflow" }),
      expect.objectContaining({ agentIdentity: "trailing-comment", name: "commented-name", source: "agent-workflow" }),
      expect.objectContaining({ agentIdentity: "named", name: "custom-name", source: "agent-workflow" }),
      expect.objectContaining({ name: "dynamic", source: "agent-workflow" }),
      expect.objectContaining({ name: "external", source: "agent-workflow" }),
      expect.objectContaining({ name: "external-wrapper", source: "agent-workflow" }),
      expect.objectContaining({ name: "imported", source: "agent-workflow" }),
      expect.objectContaining({ name: "imported-comment", source: "agent-workflow" }),
      expect.objectContaining({ name: "index-folder", source: "agent-workflow" }),
      expect.objectContaining({ name: "js-wrapper", source: "agent-workflow" }),
      expect.objectContaining({ name: "mentioned", source: "agent-workflow" }),
      expect.objectContaining({ agentIdentity: "shorthand-named", name: "shorthand-custom", source: "agent-workflow" }),
      expect.objectContaining({ name: "support", source: "agent-workflow" }),
      expect.objectContaining({ name: "team", source: "agent-workflow" }),
      expect.objectContaining({ name: "team/review", source: "agent-workflow" }),
      expect.objectContaining({ name: "typed-custom", source: "agent-workflow" }),
      expect.objectContaining({ name: "typed-variable", source: "agent-workflow" }),
      expect.objectContaining({ name: "workspace/foo", source: "agent-workflow" }),
      expect.objectContaining({ name: "wrapped", source: "agent-workflow" }),
      expect.objectContaining({ agentIdentity: "wrapped-index", name: "wrapped-custom", source: "agent-workflow" }),
    ])
  })

  it("honors quoted Agent runtime properties", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-workflow-quoted-runtime-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "agents"), { recursive: true })
    await writeFile(join(rootDir, "server", "agents", "inline.ts"), `export default defineAgent({ "runtime": false, driver: { run } })\n`, "utf8")
    await writeFile(join(rootDir, "server", "agents", "named.ts"), `export default defineAgent({ 'runtime': workflow('quoted-name'), driver: { run } })\n`, "utf8")
    await writeFile(join(rootDir, "server", "agents", "described.ts"), `export default defineAgent({ description: 'use runtime: false', runtime: false, driver: { run } })\n`, "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([
      expect.objectContaining({ name: "quoted-name", source: "agent-workflow" }),
    ])
  })

  it("honors runtime opt-outs after regexp literals", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-workflow-regexp-runtime-"))
    tempDirs.push(rootDir)
    await mkdir(join(rootDir, "server", "agents"), { recursive: true })
    await writeFile(join(rootDir, "server", "agents", "inline.ts"), "export default defineAgent({ pattern: /[{}]/, runtime: false, driver: { run } })\n", "utf8")

    expect(discoverWorkflowDefinitions({ rootDir })).toEqual([])
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
