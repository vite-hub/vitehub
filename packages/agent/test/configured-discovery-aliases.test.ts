import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { discoverAgentDefinitions } from "../src/discovery.ts"

it.each([
  ["module Capability", "const storage = defineCapability({ workspace: {} });", "return defineAgent({ capabilities: [storage] })", true],
  ["local Capability", "", "const storage = defineCapability({ workspace: {} }); return defineAgent({ capabilities: [storage] })", true],
  ["property key collision", "", "const capabilities = defineCapability({ workspace: {} }); return defineAgent({ capabilities: [] })", false],
  ["unrelated setting value", "", "const storage = defineCapability({ workspace: {} }); return defineAgent({ description: storage })", false],
  ["nested metadata", "", "const storage = defineCapability({ metadata: { workspace: false } }); return defineAgent({ capabilities: [storage] })", false],
  ["mixed Capabilities", "", "const plain = defineCapability({}); const storage = defineCapability({ workspace: {} }); return defineAgent({ capabilities: [plain, storage] })", true],
  ["shadowed module Capability", "const storage = defineCapability({ workspace: {} });", "const storage = defineCapability({}); return defineAgent({ capabilities: [storage] })", false],
  ["sibling block Capability", "", "if (condition) { const storage = defineCapability({ workspace: {} }); } return defineAgent({ capabilities: [storage] })", false],
  ["conditional first branch", "const storage = defineCapability({ workspace: {} });", "return condition ? defineAgent({ capabilities: [storage] }) : defineAgent({})", true],
  ["conditional second branch", "const storage = defineCapability({ workspace: {} });", "return condition ? defineAgent({}) : defineAgent({ capabilities: [storage] })", true],
  ["nested helper", "", "return defineAgent({ presets: { helper: defineAgent({ workspace: {} }) } })", false],
] as const)("discovers configured ownership: %s", async (_name, module, body, ownsWorkspace) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-configured-alias-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), `${module}\nexport default defineAgent({ options: {}, configure: () => { ${body} } })`)
    const definitions = discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.workspace).toBe(ownsWorkspace ? "support" : undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(["({ storage })", "(storage)", "storage", "({ alias: storage })", "({ nested: { storage } })", "([storage])", "({ ...storage })", "({ storage = fallback })", "(storage: Capability)"])("does not resolve callback parameter %s to a module Capability", async (parameters) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-configured-parameter-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), `const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: ${parameters} => defineAgent({ capabilities: [storage] }) })`)
    const definitions = discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
    expect(definitions[0]?.workspace).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


it.each([
  "(options: typeof storage)",
  "(options = storage)",
  "({ other = storage })",
  "({ storage: other })",
  "({ [storage]: other })",
  "(options: Record<string, typeof storage>)",
  "({ nested: { other = storage } })",
  "([other = storage])",
])("does not treat type or default references in %s as parameter bindings", async (parameters) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-configured-parameter-reference-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), `const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: ${parameters} => defineAgent({ capabilities: [storage] }) })`)
    const definitions = discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
    expect(definitions[0]?.workspace).toBe("support")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
