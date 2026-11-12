import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { discoverWorkflowDefinitions } from "../src/discovery.ts"
import { discoverWorkflowDevDefinitions } from "../src/internal/dev-registry.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-dev-discovery-"))
  roots.push(root)
  return root
}

async function writeSource(file: string, source = "export default async () => 42\n") {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, source)
}

function agentSource(workflowName: string) {
  return `export default defineAgent({ runtime: agentWorkflow(${JSON.stringify(workflowName)}) })\n`
}

describe("Workflow development discovery", () => {
  it("ignores Agent Workflows that share a name with a standalone Workflow", async () => {
    const root = await createRoot()
    const handler = join(root, "server/workflows/welcome.ts")
    await writeSource(handler)
    await writeSource(join(root, "server/agents/assistant/agent.ts"), agentSource("welcome"))

    expect(discoverWorkflowDevDefinitions(root)).toEqual([
      { handler, name: "welcome", source: "server-workflows" },
    ])
    expect(() => discoverWorkflowDefinitions({ rootDir: root })).toThrow('Duplicate workflow name "welcome"')
  })

  it("ignores colliding Agent Workflow names when no standalone Workflows exist", async () => {
    const root = await createRoot()
    await writeSource(join(root, "server/agents/first/agent.ts"), agentSource("shared"))
    await writeSource(join(root, "server/agents/second/agent.ts"), agentSource("shared"))

    expect(discoverWorkflowDevDefinitions(root)).toEqual([])
    expect(() => discoverWorkflowDefinitions({ rootDir: root })).toThrow('Duplicate agent workflow name "shared"')
  })
})
