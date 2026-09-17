import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { discoverAgentDefinitions } from "../src/discovery.ts"

async function workspaceFor(source: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-discovery-review-alias-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), source)
    return discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })[0]?.workspace
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each(["@vite-hub/agent", "vite-hub/agent"])("discovers named and namespace Capability aliases from %s", async (module) => {
  for (const [imports, factory] of [
    [`import { defineCapability as capability } from "${module}"`, "capability"],
    [`import * as hub from "${module}"`, "hub.defineCapability"],
    [`import { defineCapability as capability } from "${module}"`, "capability<Runtime>"],
    [`import * as hub from "${module}"`, "hub.defineCapability<Runtime>"],
  ]) {
    for (const inline of [true, false]) {
      const declaration = inline ? "" : `const storage = ${factory}({ workspace: {} });`
      const capability = inline ? `${factory}({ workspace: {} })` : "storage"
      await expect(workspaceFor(`${imports}; ${declaration} export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: [${capability}] }) })`)).resolves.toBe("support")
    }
  }
})

it("does not recognize another package's similarly named factory", async () => {
  await expect(workspaceFor('import * as hub from "other-package"; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: [hub.defineCapability({ workspace: {} })] }) })')).resolves.toBeUndefined()
})

it.each(["options", "(options)"])("preserves module Capabilities when the %s parameter shadows a declaration", async (parameters) => {
  await expect(workspaceFor(`const options = {}; const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: ${parameters} => defineAgent({ capabilities: [storage] }) })`)).resolves.toBe("support")
})

it("preserves an unparenthesized callback parameter through callback aliases", async () => {
  await expect(workspaceFor('const options = {}; const storage = defineCapability({ workspace: {} }); const configure = options => defineAgent({ capabilities: [storage] }); const callback = configure; export default defineAgent({ options: {}, configure: callback })')).resolves.toBe("support")
})

it.each([
  ['import { defineCapability as capability } from "@vite-hub/agent"', 'capability => defineAgent({ capabilities: [capability({ workspace: {} })] })'],
  ['import * as hub from "@vite-hub/agent"', 'hub => defineAgent({ channels: { custom: { capabilities: [hub.defineCapability({ workspace: {} })] } } })'],
])("rejects parameter-derived Capability factories: %s", async (imports, configure) => {
  await expect(workspaceFor(`${imports}; export default defineAgent({ options: {}, configure: ${configure} })`)).rejects.toThrow("option-derived Capability expression")
})

it("honors a locally shadowed Capability factory", async () => {
  await expect(workspaceFor('import { defineCapability as capability } from "@vite-hub/agent"; export default defineAgent({ options: {}, configure: () => { const capability = () => ({}); return defineAgent({ capabilities: [capability({ workspace: {} })] }) } })')).resolves.toBeUndefined()
})

it("rejects an opaque local member that shadows a Capability namespace", async () => {
  await expect(workspaceFor('import * as hub from "@vite-hub/agent"; export default defineAgent({ options: {}, configure: () => { const hub = {}; return defineAgent({ capabilities: [hub.defineCapability({ workspace: {} })] }) } })')).rejects.toThrow("cannot inspect a local Capability member")
})

it.each([
  '() => workspaceAgent',
  '() => (workspaceAgent)',
  '() => { return workspaceAgent }',
  '() => { const local = workspaceAgent; return local }',
])("follows returned Agent aliases: %s", async (configure) => {
  await expect(workspaceFor(`const workspaceAgent = defineAgent({ workspace: {} }); export default defineAgent({ options: {}, configure: ${configure} })`)).resolves.toBe("support")
})

it("excludes a Workspace alias used only in returned Agent settings", async () => {
  await expect(workspaceFor('const workspaceAgent = defineAgent({ workspace: {} }); export default defineAgent({ options: {}, configure: () => defineAgent({ presets: { helper: workspaceAgent } }) })')).resolves.toBeUndefined()
})

it.each(["@vite-hub/agent/channels", "vite-hub/agent/channels"])("inspects local Channel constructors from %s", async (module) => {
  for (const [imports, factory] of [
    [`import { defineChannel } from "${module}"`, "defineChannel"],
    [`import { defineChannel as channel } from "${module}"`, "channel"],
    [`import * as channels from "${module}"`, "channels.defineChannel<Runtime>"],
    [`import { defineChannel as channel } from "${module}"; const factory = channel`, "factory"],
  ]) {
    for (const inline of [true, false]) {
      const value = `${factory}("custom", { capabilities: [storage] })`
      const declaration = inline ? "" : `const custom = ${value};`
      await expect(workspaceFor(`${imports}; const storage = defineCapability({ workspace: {} }); ${declaration} export default defineAgent({ options: {}, configure: () => defineAgent({ channels: { custom: ${inline ? value : "custom"} } }) })`)).resolves.toBe("support")
    }
  }
})

it.each([
  'defineChannel => defineAgent({ channels: { custom: defineChannel("custom", { capabilities: [storage] }) } })',
  '() => { const defineChannel = () => ({}); return defineAgent({ channels: { custom: defineChannel("custom", { capabilities: [storage] }) } }) }',
])("requires explicit ownership for shadowed Channel factories: %s", async (configure) => {
  await expect(workspaceFor(`import { defineChannel } from "@vite-hub/agent/channels"; const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: ${configure} })`)).rejects.toThrow("opaque Channel")
})

it.each([
  ["[...list]", true],
  ["[plain, ...list]", true],
  ["[...([...list])]", true],
  ["[...empty]", false],
  ["[...cycle]", false],
])("follows spread Capability lists: %s", async (capabilities, workspace) => {
  await expect(workspaceFor(`const storage = defineCapability({ workspace: {} }); const plain = defineCapability({ id: "plain" }); const list = [storage]; const empty = [plain]; const cycle = [...cycle]; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: ${capabilities} }) })`)).resolves.toBe(workspace ? "support" : undefined)
})

it("does not trust another package's Channel constructor", async () => {
  await expect(workspaceFor('import { defineChannel } from "other-package"; const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: () => defineAgent({ channels: { custom: defineChannel("custom", { capabilities: [storage] }) } }) })')).rejects.toThrow("opaque Channel")
})

it.each([
  'const [list] = lists',
  'const { list } = { list: [storage] }',
  'const { values: list } = { values: [storage] }',
  'const [[...list]] = lists',
])("rejects destructured Capability lists before generating Workspace wiring: %s", async (declaration) => {
  const source = `const storage = defineCapability({ workspace: {} }); const lists = [[storage]]; ${declaration}; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: [...list] }) })`
  await expect(workspaceFor(source)).rejects.toThrow("Agent Workspace discovery cannot inspect a destructured Capability binding")
  await expect(workspaceFor(source.replace("capabilities: [...list]", "workspace: {}, capabilities: [...list]"))).resolves.toBe("support")
})

it("preserves direct bindings that shadow destructured Capability lists", async () => {
  await expect(workspaceFor('const [list] = [[]]; const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: () => { const list = [storage]; return defineAgent({ capabilities: [...list] }) } })')).resolves.toBe("support")
})

it.each(["const", "let", "var"])("discovers later %s declarators", async (kind) => {
  await expect(workspaceFor(`${kind} plain = defineCapability({}), storage = defineCapability({ workspace: {} }), list = [plain, storage]; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: list }) })`)).resolves.toBe("support")
})

it("preserves local shadowing by later declarators", async () => {
  await expect(workspaceFor('const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: () => { const unused = {}, storage = defineCapability({}); return defineAgent({ capabilities: [storage] }) } })')).resolves.toBeUndefined()
})

it("does not treat commas in generic arguments as declarators", async () => {
  await expect(workspaceFor('const storage = defineCapability<Input, Runtime>({ workspace: {} }), list: Array<Capability<Runtime>> = [storage]; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: list }) })')).resolves.toBe("support")
})

it.each([
  'enabled ? [storage] : []',
  'enabled ? [] : [storage]',
  '(enabled) ? [storage] : []',
  '(enabled ? [storage] : [])',
  'enabled ? (other ? [storage] : []) : []',
  '[enabled ? storage : plain]',
  '[...(enabled ? [storage] : [])]',
])("discovers conditional Capability branches: %s", async (capabilities) => {
  await expect(workspaceFor(`const storage = defineCapability({ workspace: {} }); const plain = defineCapability({}); export default defineAgent({ options: { enabled: true }, configure: ({ enabled }) => defineAgent({ capabilities: ${capabilities} }) })`)).resolves.toBe("support")
})

it("keeps plain conditional Capabilities plain", async () => {
  await expect(workspaceFor('const plain = defineCapability({}); export default defineAgent({ options: {}, configure: enabled => defineAgent({ capabilities: enabled ? [plain] : [] }) })')).resolves.toBeUndefined()
})

it.each([
  '[plain].concat(storage)',
  '([plain]).concat(storage)',
  '(([])).concat(storage)',
  '[plain]["concat"](storage)',
  '[plain]?.concat(storage)',
  '[storage].filter(() => false)',
  '([plain] as Capability[]).concat(storage)',
  '([plain] satisfies Capability[]).concat(storage)',
  '(([plain] as const) satisfies readonly Capability[]).concat(storage)',
])("requires explicit ownership for expressions extending Capability arrays: %s", async (capabilities) => {
  const source = `const plain = defineCapability({}); const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: ${capabilities} }) })`
  await expect(workspaceFor(source)).rejects.toThrow("opaque Capability expression")
  await expect(workspaceFor(source.replace("capabilities:", "workspace: {}, capabilities:"))).resolves.toBe("support")
})


it.each(["as Capability[]", "satisfies Capability[]", "as const"])("preserves standalone asserted Capability lists: %s", async assertion => {
  for (const [capability, workspace] of [["plain", undefined], ["storage", "support"]]) {
    await expect(workspaceFor(`const plain = defineCapability({}); const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: ([${capability}] ${assertion}) }) })`)).resolves.toBe(workspace)
  }
})

it.each([
  'false || [storage]',
  'true && [storage]',
  'undefined ?? [storage]',
  '((false || [storage]))',
  '([plain]) && [storage]',
  '[...(false || [storage])]',
  '([plain] as Capability[] || [storage])',
  '([plain] satisfies Capability[] && [storage])',
  '([plain] as Capability[] ?? [storage])',
])("requires explicit ownership for logical Capability expressions: %s", async capabilities => {
  const source = `const plain = defineCapability({}); const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: ${capabilities} }) })`
  await expect(workspaceFor(source)).rejects.toThrow("logical Capability expression")
  await expect(workspaceFor(source.replace("capabilities:", "workspace: {}, capabilities:"))).resolves.toBe("support")
})

it.each([
  'condition ? "workspace" : "plain"',
  'selection',
  '`work${suffix}`',
  '"work" + suffix',
  '("plain") && "workspace"',
  '("plain") ? "workspace" : "plain"',
])("requires explicit ownership for dynamic preset selection: %s", async preset => {
  const source = `const selection = condition ? "workspace" : "plain"; const storage = defineAgent({ workspace: {} }); const plain = defineAgent({}); export default defineAgent({ presets: { workspace: storage, plain }, preset: ${preset} })`
  await expect(workspaceFor(source)).rejects.toThrow("dynamic preset selection")
  await expect(workspaceFor(source.replace("presets:", "workspace: {}, presets:"))).resolves.toBe("support")
})


it("preserves a static preset alias without semicolons", async () => {
  await expect(workspaceFor(`const selection = "workspace"
const storage = defineAgent({ workspace: {} })
export default defineAgent({ presets: { workspace: storage }, preset: selection })`)).resolves.toBe("support")
})

it.each(["as", "satisfies"])("discovers both branches after a Capability %s assertion", async assertion => {
  await expect(workspaceFor(`const plain = defineCapability({}); const storage = defineCapability({ workspace: {} }); const list = [plain]; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: ([plain] ${assertion} Capability[] === list ? [plain] : [storage]) }) })`)).resolves.toBe("support")
})

it.each(["importedOptions", "{ ...importedOptions }"])("rejects opaque Capability options: %s", async options => {
  const source = `import { importedOptions } from "./options"; const storage = defineCapability(${options}); export default defineAgent({ capabilities: [storage] })`
  await expect(workspaceFor(source)).rejects.toThrow("cannot inspect opaque Agent settings")
  await expect(workspaceFor(source.replace("capabilities: [storage]", "workspace: {}, capabilities: [storage]"))).resolves.toBe("support")
})

it.each(["importedPresets", "{ ...importedPresets }"])("rejects opaque preset registries: %s", async presets => {
  const source = `import { importedPresets } from "./presets"; export default defineAgent({ preset: "storage", presets: ${presets} })`
  await expect(workspaceFor(source)).rejects.toThrow("cannot inspect opaque Agent settings")
  await expect(workspaceFor(source.replace('preset: "storage"', 'workspace: {}, preset: "storage"'))).resolves.toBe("support")
})

it("inspects locally defined Capability options and preset registries", async () => {
  await expect(workspaceFor('const options = { workspace: {} }; const storage = defineCapability({ ...options }); export default defineAgent({ capabilities: [storage] })')).resolves.toBe("support")
  await expect(workspaceFor('const registry = { storage: defineAgent({ workspace: {} }) }; export default defineAgent({ preset: "storage", presets: { ...registry } })')).resolves.toBe("support")
})


it.each(["{}", "{ workspace: {} }"])("inspects curried Capability settings: %s", async settings => {
  await expect(workspaceFor(`const storage = defineCapability<Config>()(${settings}); export default defineAgent({ capabilities: [storage] })`)).resolves.toBe(settings === "{}" ? undefined : "support")
})

it.each(["importedOptions", "{ ...importedOptions }"])("rejects opaque curried Capability settings: %s", async settings => {
  await expect(workspaceFor(`import { importedOptions } from "./options"; const storage = defineCapability<Config>()(${settings}); export default defineAgent({ capabilities: [storage] })`)).rejects.toThrow("cannot inspect opaque Agent settings")
})

it.each(["options.caps", 'options["caps"]', "options"])("rejects option-derived Capability lists: %s", async capabilities => {
  const source = `const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: { caps: [storage] }, configure: options => defineAgent({ capabilities: ${capabilities} }) })`
  await expect(workspaceFor(source)).rejects.toThrow("option-derived Capability expression")
  await expect(workspaceFor(source.replace("options: { caps:", "workspace: {}, options: { caps:"))).resolves.toBe("support")
})

it.each(["agents.storage", 'agents["storage"]', "agents?.storage"])("rejects returned Agent member values: %s", async member => {
  for (const configure of [`() => ${member}`, `() => { return ${member} }`, `() => { const selected = ${member}; return selected }`]) {
    const source = `const agents = { storage: defineAgent({ workspace: {} }) }; export default defineAgent({ options: {}, configure: ${configure} })`
    await expect(workspaceFor(source)).rejects.toThrow("configure result factory")
    await expect(workspaceFor(source.replace("options: {}", "workspace: {}, options: {}"))).resolves.toBe("support")
  }
})

it.each([
  "if (options.storage) { return defineAgent({ workspace: {} }) } return defineAgent({})",
  "if (options.storage) { if (options.enabled) { return defineAgent({ workspace: {} }) } } return defineAgent({})",
  "if (options.storage) { return options.enabled ? defineAgent({}) : defineAgent({ workspace: {} }) } return defineAgent({})",
  "for (const item of options.items) { if (item.storage) return defineAgent({ workspace: {} }) } return defineAgent({})",
  "switch (options.mode) { case 'storage': return defineAgent({ workspace: {} }); default: return defineAgent({}) }",
  "try { if (options.storage) return defineAgent({ workspace: {} }) } catch { return defineAgent({}) } return defineAgent({})",
])("discovers Workspace ownership in each configure return: %s", async (body) => {
  await expect(workspaceFor(`export default defineAgent({ options: {}, configure: options => { ${body} } })`)).resolves.toBe("support")
})

it.each([
  "function helper() { if (options.storage) { return defineAgent({ workspace: {} }) } return defineAgent({}) }",
  "const helper = () => { if (options.storage) { return defineAgent({ workspace: {} }) } return defineAgent({}) };",
  "if (options.storage) { return defineAgent({ presets: { helper: defineAgent({ workspace: {} }) } }) }",
])("excludes nested helper results from configure returns: %s", async (body) => {
  await expect(workspaceFor(`export default defineAgent({ options: {}, configure: options => { ${body} return defineAgent({}) } })`)).resolves.toBeUndefined()
})

it("requires explicit ownership for an opaque early configure return", async () => {
  await expect(workspaceFor('const build = () => defineAgent({ workspace: {} }); export default defineAgent({ options: {}, configure: options => { if (options.storage) { return build() } return defineAgent({}) } })')).rejects.toThrow("cannot inspect a configure result factory")
})

it.each([
  "if (options.early) return defineAgent({}); const ignored = options.other ? defineAgent({ workspace: {} }) : defineAgent({});",
  "if (options.early) return defineAgent({})\nconst ignored = options.other ? defineAgent({ workspace: {} }) : defineAgent({})\n",
  "if (options.early) { return defineAgent({}) } options.other ? defineAgent({ workspace: {} }) : defineAgent({});",
  "if (options.early) return defineAgent({}); options.other ? defineAgent({ workspace: {} }) : defineAgent({});",
])("excludes unused conditionals after a configure return: %s", async (body) => {
  await expect(workspaceFor(`export default defineAgent({ options: {}, configure: options => { ${body} return defineAgent({}) } })`)).resolves.toBeUndefined()
})
