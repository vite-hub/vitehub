import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { assertAgentDefaultExport } from "../src/discovery.ts"
import { hubAgent, listAgentDefinitionFiles } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function agentFile(name: string, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-default-export-"))
  roots.push(root)
  const file = join(root, name)
  await writeFile(file, source, "utf8")
  return file
}

describe("Agent default exports", () => {
  it.each([
    ["no imports or exports", "agent.ts", "async function runSummaryAgent() {}\n"],
    ["no exports in an explicit ES module", "agent.mjs", "function summary() {}\n"],
    ["only named exports", "agent.ts", "export async function runSummaryAgent() {}\n"],
    ["a default interface", "agent.ts", "export default interface Summary { title: string }\n"],
    ["a type-only default", "agent.ts", "type Summary = { title: string }\nexport type { Summary as default }\n"],
    ["an inline type-only default", "agent.ts", "type Summary = { title: string }\nexport { type Summary as default }\n"],
    ["a local interface as default", "agent.ts", "interface Summary { title: string }\nexport { Summary as default }\n"],
    ["a local type in a default expression", "agent.ts", "interface Summary { title: string }\nexport default Summary\n"],
    ["only imports", "agent.ts", 'import "./setup"\n'],
  ])("names a file with %s", async (_label, name, source) => {
    const handler = await agentFile(name, source)

    await expect(assertAgentDefaultExport({ handler, name: "summary" })).rejects.toMatchObject({
      code: "AGENT_DEFINITION_EXPORT_MISSING",
      message: expect.stringContaining(`Agent "summary" has no default export in ${handler}`),
    })
  })

  it.each([
    ["export default", "agent.ts", "export default defineAgent({ driver: { model } })\n"],
    ["an export clause", "agent.ts", "const agent = defineAgent({ driver: { model } })\nexport { agent as default }\n"],
    ["a value that shares a name with a type", "agent.ts", "interface Agent {}\nconst Agent = {}\nexport { Agent as default }\n"],
    ["a re-exported default", "agent.ts", 'export { default } from "./definition"\n'],
    ["module.exports in .js", "agent.js", "module.exports = defineAgent({ driver: { model } })\n"],
    ["module.exports in .cts", "agent.cts", "module.exports = defineAgent({ driver: { model } })\n"],
  ])("accepts %s", async (_label, name, source) => {
    const handler = await agentFile(name, source)

    await expect(assertAgentDefaultExport({ handler, name: "support" })).resolves.toBeUndefined()
  })

  it("stops the build for an Agent folder of helpers, and discovery still lists it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-default-export-build-"))
    roots.push(root)
    await mkdir(join(root, "server", "agents", "summary"), { recursive: true })
    await writeFile(join(root, "server", "agents", "summary", "agent.ts"), "async function runSummaryAgent() {}\n", "utf8")
    await writeFile(join(root, "server", "agents", "summary", "instructions.md"), "Summarize the call.\n", "utf8")

    expect(listAgentDefinitionFiles(root)).toEqual([
      expect.objectContaining({ name: "summary" }),
    ])
    const plugin = hubAgent({ providers: { state: { driver: "memory" } } })
    await expect((plugin.configResolved as (config: unknown) => Promise<void>)({ root, command: "build", plugins: [], build: { outDir: "dist" }, resolve: { alias: [] } }))
      .rejects.toMatchObject({ code: "AGENT_DEFINITION_EXPORT_MISSING" })
  })
})
