import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { discoverAgentDefinitions } from "../src/discovery.ts"

it.each([
  ["block var shadows module", "if (true) { var storage = defineCapability({ id: 'plain' }) } return defineAgent({ capabilities: [storage] })", false],
  ["block let stays local", "if (true) { let storage = defineCapability({ id: 'plain' }) } return defineAgent({ capabilities: [storage] })", true],
  ["block const stays local", "if (true) { const storage = defineCapability({ id: 'plain' }) } return defineAgent({ capabilities: [storage] })", true],
  ["nested function var stays local", "function helper() { var storage = defineCapability({ id: 'plain' }) } return defineAgent({ capabilities: [storage] })", true],
  ["nested arrow var stays local", "const helper = () => { var storage = defineCapability({ id: 'plain' }) }; return defineAgent({ capabilities: [storage] })", true],
  ["first parenthesized branch", "return condition ? (defineAgent({ capabilities: [storage] })) : defineAgent({})", true],
  ["second parenthesized branch", "return condition ? defineAgent({}) : (defineAgent({ capabilities: [storage] }))", true],
  ["multiple branch parentheses", "return condition ? ((defineAgent({ capabilities: [storage] }))) : (defineAgent({}))", true],
  ["parenthesized conditional", "return (condition ? (defineAgent({ capabilities: [storage] })) : defineAgent({}))", true],
  ["nested settings stay excluded", "return defineAgent({ driver: condition ? (defineAgent({ capabilities: [storage] })) : {} })", false],
  ["nested helper stays excluded", "return defineAgent({ presets: { helper: (defineAgent({ capabilities: [storage] })) } })", false],
] as const)("uses JavaScript scope and branch semantics: %s", async (_name, body, workspace) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-discovery-scopes-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), `const storage = defineCapability({ id: 'storage', workspace: {} }); export default defineAgent({ options: {}, configure: () => { ${body} } })`)
    const definitions = discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
    expect(definitions[0]?.workspace).toBe(workspace ? "support" : undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
