import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { discoverAgentDefinitions } from "../src/discovery.ts"

it.each([
  "{ name: 'shared' }",
  "void 0",
  "(void 0)",
  "void sideEffect()",
  '{ name: (void 0, "shared") }',
  '(void 0, "shared")',
  "options.prod ? { name: 'prod' } : { name: 'dev' }",
  "options.prod ? 'prod' : 'dev'",
])("keeps configured Workspace references separate from owned storage: %s", async (workspace) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-discovery-reference-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(join(folder, "workspace"), { recursive: true })
    await writeFile(join(folder, "agent.ts"), `export default defineAgent({
      options: { workspaceName: 'shared' },
      configure: options => defineAgent({ workspace: ${workspace} }),
    })`)
    await writeFile(join(folder, "workspace", "agent.ts"), "export default defineAgent({ workspace: {} })")
    expect(discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })).toEqual([
      expect.objectContaining({ name: "support", source: "server-agents", workspace: undefined }),
      expect.objectContaining({ name: "support/workspace", source: "server-agent-workspace", workspace: "support/workspace" }),
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  ["condition helper is not a callback result", "return enabled() ? defineAgent({}) : defineAgent({})", false],
  ["undefined Capability Workspace stays plain", "const plain = defineCapability({ id: 'plain', workspace: undefined }); return defineAgent({ capabilities: [plain] })", false],
  ["aliased undefined Capability Workspace stays plain", "const omitted = undefined; const plain = defineCapability({ id: 'plain', workspace: omitted }); return defineAgent({ capabilities: [plain] })", false],
  ["undefined Capability preserves nested ownership", "const wrapper = defineCapability({ id: 'wrapper', workspace: undefined, capabilities: [storage] }); return defineAgent({ capabilities: [wrapper] })", true],
  ["conditional owned Workspace remains owned", "return defineAgent({ workspace: options.prod ? { name: 'prod' } : {} })", true],
  ["undefined name owns Workspace", "return defineAgent({ workspace: { name: undefined } })", true],
  ["aliased undefined name owns Workspace", "const name = undefined; return defineAgent({ workspace: { name } })", true],
  ["aliased string name references Workspace", "const name = 'shared'; return defineAgent({ workspace: { name } })", false],
  ["sequence Workspace owns storage", "return defineAgent({ workspace: (void 0, {}) })", true],
  ["nested sequence Workspace owns storage", "return defineAgent({ workspace: (void 0, (void 0, {})) })", true],
  ["aliased sequence Workspace owns storage", "const workspace = (void 0, {}); return defineAgent({ workspace })", true],
  ["sequence Capability Workspace owns storage", "const storage = defineCapability({ workspace: (void 0, {}) }); return defineAgent({ capabilities: [storage] })", true],
  ["void wraps sequence", "return defineAgent({ workspace: void (0, {}) })", false],
  ["void Capability Workspace stays plain", "const plain = defineCapability({ id: 'plain', workspace: void 0 }); return defineAgent({ capabilities: [plain] })", false],
  ["aliased void Workspace stays plain", "const omitted = void 0; return defineAgent({ workspace: omitted })", false],
  ["void Workspace keeps Capability ownership", "return defineAgent({ workspace: void 0, capabilities: [storage] })", true],
  ["void name owns Workspace", "return defineAgent({ workspace: { name: void 0 } })", true],
  ["undefined Workspace stays plain", "return defineAgent({ driver: 'codex', workspace: undefined })", false],
  ["undefined Workspace keeps Capability ownership", "return defineAgent({ workspace: undefined, capabilities: [storage] })", true],
  ["later var shadows module", "return defineAgent({ capabilities: [storage] }); var storage = defineCapability({ id: 'plain' })", false],
  ["later block var shadows module", "return defineAgent({ capabilities: [storage] }); if (true) { var storage = defineCapability({ id: 'plain' }) }", false],
  ["later nested function var stays local", "return defineAgent({ capabilities: [storage] }); function helper() { var storage = defineCapability({ id: 'plain' }) }", true],
  ["Channel Capability owns Workspace", "return defineAgent({ channels: { custom: { capabilities: [storage] } } })", true],
  ["aliased Channel Capability owns Workspace", "const custom = { capabilities: [storage] }; const channels = { custom }; return defineAgent({ channels })", true],
  ["plain Channel stays plain", "return defineAgent({ channels: { custom: { capabilities: [defineCapability({ id: 'plain' })] } } })", false],
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

it.each(["options.workspaceName", "getWorkspaceName(options)"])("rejects an opaque Workspace name: %s", async (name) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-discovery-name-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), `export default defineAgent({ options: {}, configure: options => defineAgent({ workspace: { name: ${name} } }) })`)
    expect(() => discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })).toThrow("dynamic Workspace name")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
