import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { discoverAgentDefinitions } from "../src/discovery.ts"

async function discover(source: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-imported-configure-"))
  try {
    const folder = join(root, "server", "agents", "notes")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), source)
    return discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

it.each([
  'import configure from "./configure"; export default defineAgent({ options: {}, configure })',
  'import { configure } from "./configure"; export default defineAgent({ options: {}, configure })',
  'import { configure as setup } from "./configure"; export default defineAgent({ options: {}, configure: setup })',
  'import * as callbacks from "./configure"; export default defineAgent({ options: {}, configure: callbacks.configure })',
  'import configure from "./configure"; const setup = configure; const callback = setup; export default defineAgent({ options: {}, configure: callback })',
])("rejects opaque imported configure callbacks before generating Workspace wiring: %s", async (source) => {
  await expect(discover(source)).rejects.toThrow("Agent Workspace discovery cannot inspect an imported configure callback")
})

it("discovers a locally defined callback that returns a Workspace Agent", async () => {
  const definitions = await discover('const configure = () => defineAgent({ workspace: {} }); export default defineAgent({ options: {}, configure })')
  expect(definitions[0]?.workspace).toBe("notes")
})

it.each(["options", "(options)", "(options: Options)"])("allows inline callback parameters to shadow imported bindings: %s", async (parameters) => {
  const definitions = await discover(`import options from "./options"; export default defineAgent({ options: {}, configure: ${parameters} => defineAgent({ workspace: {} }) })`)
  expect(definitions[0]?.workspace).toBe("notes")
})

it("does not inspect an unselected imported callback", async () => {
  const definitions = await discover('import configure from "./configure"; const unused = defineAgent({ options: {}, configure }); export default defineAgent({ workspace: {} })')
  expect(definitions[0]?.workspace).toBe("notes")
})

it("allows an aliased local callback whose parameter shadows an import", async () => {
  const definitions = await discover('import options from "./options"; const configure = (options: Options) => defineAgent({ workspace: {} }); const setup = configure; export default defineAgent({ options: {}, configure: setup })')
  expect(definitions[0]?.workspace).toBe("notes")
})

it.each([
  "capabilities: [storage]",
  "channels: { custom: { capabilities: [storage] } }",
  "capabilities: [alias]",
])("rejects opaque imported Capability values: %s", async (settings) => {
  await expect(discover(`import { storage } from "./storage"; const alias = storage; export default defineAgent({ options: {}, configure: () => defineAgent({ ${settings} }) })`)).rejects.toThrow("Agent Workspace discovery cannot inspect an imported Capability")
})

it("accepts an explicit Workspace marker with an imported Capability", async () => {
  const definitions = await discover('import { storage } from "./storage"; export default defineAgent({ options: {}, configure: () => defineAgent({ workspace: {}, capabilities: [storage] }) })')
  expect(definitions[0]?.workspace).toBe("notes")
})

it("allows callback parameters to shadow imported Capabilities", async () => {
  const definitions = await discover('import { storage } from "./storage"; export default defineAgent({ options: {}, configure: storage => defineAgent({ capabilities: [storage] }) })')
  expect(definitions[0]?.workspace).toBeUndefined()
})

it("rejects opaque namespace Capability values", async () => {
  await expect(discover('import * as capabilities from "./storage"; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: [capabilities.storage] }) })')).rejects.toThrow("Agent Workspace discovery cannot inspect an imported Capability")
})

it.each([
  "channels: importedChannels",
  "channels: { custom: importedChannel }",
  "channels: { custom: alias }",
  "channels: { ...importedChannels }",
  "channels: { custom: { ...importedChannel } }",
  "channels: namespace.channels",
  "channels: { custom: namespace.channel }",
])("rejects opaque imported Channels: %s", async (settings) => {
  await expect(discover(`import { importedChannels, importedChannel } from "./channels"; import * as namespace from "./channels"; const alias = importedChannel; export default defineAgent({ options: {}, configure: () => defineAgent({ ${settings} }) })`)).rejects.toThrow("Agent Workspace discovery cannot inspect an imported Channel")
})

it("accepts an explicit Workspace marker with imported Channels", async () => {
  const definitions = await discover('import channels from "./channels"; export default defineAgent({ options: {}, configure: () => defineAgent({ workspace: {}, channels }) })')
  expect(definitions[0]?.workspace).toBe("notes")
})

it.each([
  'channels => defineAgent({ channels })',
  '() => { const channels = {}; return defineAgent({ channels }) }',
])("allows local bindings to shadow imported Channels: %s", async (configure) => {
  const definitions = await discover(`import channels from "./channels"; export default defineAgent({ options: {}, configure: ${configure} })`)
  expect(definitions[0]?.workspace).toBeUndefined()
})

it.each([
  'extends: importedParent',
  'extends: alias',
  'extends: namespace.parent',
  'preset: "selected", presets: { selected: importedParent }',
])("rejects opaque imported Agent parents: %s", async (settings) => {
  const source = `import importedParent from "./parent"; import * as namespace from "./parent"; const alias = importedParent; export default defineAgent({ options: {}, configure: () => defineAgent({ ${settings} }) })`
  await expect(discover(source)).rejects.toThrow("Agent Workspace discovery cannot inspect an imported Agent parent")
  const definitions = await discover(source.replace(settings, `workspace: {}, ${settings}`))
  expect(definitions[0]?.workspace).toBe("notes")
})

it.each(["@vite-hub/agent/channels", "vite-hub/agent/channels", "./channels"])("rejects opaque Channel references with only a namespace import from %s", async (module) => {
  for (const channels of ["namespace.channels", "{ custom: namespace.channel }"]) {
    const source = `import * as namespace from "${module}"; export default defineAgent({ options: {}, configure: () => defineAgent({ channels: ${channels} }) })`
    await expect(discover(source)).rejects.toThrow("Agent Workspace discovery cannot inspect an imported Channel")
    const definitions = await discover(source.replace("channels:", "workspace: {}, channels:"))
    expect(definitions[0]?.workspace).toBe("notes")
  }
})

it("preserves local parent shadowing and ignores unselected imported parents", async () => {
  const definitions = await discover('import parent from "./parent"; export default defineAgent({ options: {}, configure: () => { const parent = defineAgent({ workspace: {} }); return defineAgent({ extends: parent }) } })')
  expect(definitions[0]?.workspace).toBe("notes")
  const plain = await discover('import parent from "./parent"; const local = defineAgent({}); export default defineAgent({ preset: "local", presets: { local, unused: parent } })')
  expect(plain[0]?.workspace).toBeUndefined()
})

it.each([
  ["named function expression does not shadow factory", 'configure: () => { const unused = function make() {}; return make({ workspace: {} }) }', true],
  ["local factory alias", 'configure: () => { const factory = make; return factory({ workspace: {} }) }', true],
  ["nested factory aliases", 'configure: () => { const factory = make; const create = factory; return create({ workspace: {} }) }', true],
  ["nested unused helper", 'configure: () => { function unused() { return make({ workspace: {} }) } const plain = make({}); return plain }', false],
  ["nested unused arrow", 'configure: () => { const unused = () => { return make({ workspace: {} }) }; const plain = make({}); return plain }', false],
  ["outer Workspace binding", 'configure: () => { function unused() { return make({}) } const storage = make({ workspace: {} }); return storage }', true],
])("discovers returned Agent factories: %s", async (_name, settings, workspace) => {
  const definitions = await discover(`import { defineAgent as make } from "@vite-hub/agent"; export default defineAgent({ options: {}, ${settings} })`)
  expect(definitions[0]?.workspace).toBe(workspace ? "notes" : undefined)
})

it.each([
  'configure: () => { const build = () => defineAgent({ workspace: {} }); return build() }',
  'configure: () => { function build() { return defineAgent({ workspace: {} }) }; return build() }',
  'configure: () => { const build = () => defineAgent({ workspace: {} }); return flag ? defineAgent({}) : build() }',
  'configure: make => make({ workspace: {} })',
  'configure: () => { const make = options => options; return make({ workspace: {} }) }',
  'configure: () => { function make(options) { return options }; return make({ workspace: {} }) }',
  'configure: () => { const factory = make({}); return factory({ workspace: {} }) }',
])("rejects opaque configure result factories: %s", async (settings) => {
  const source = `import { defineAgent as make } from "@vite-hub/agent"; export default defineAgent({ options: {}, ${settings} })`
  await expect(discover(source)).rejects.toThrow("Agent Workspace discovery cannot inspect a configure result factory")
  const definitions = await discover(source.replace("options: {}", "options: {}, workspace: {}"))
  expect(definitions[0]?.workspace).toBe("notes")
})

it("rejects a module-local helper returned by an expression callback", async () => {
  await expect(discover('const build = () => defineAgent({ workspace: {} }); export default defineAgent({ options: {}, configure: () => build() })')).rejects.toThrow("Agent Workspace discovery cannot inspect a configure result factory")
})

it.each([
  'builders["workspace"]()',
  'builders[keys["workspace"]]()',
  'builders.group["workspace"]()',
  'builders["group"].workspace()',
])("rejects computed configure result factories: %s", async (result) => {
  const source = `const keys = { workspace: "workspace" }; const workspace = () => defineAgent({ workspace: {} }); const builders = { workspace, group: { workspace } }; export default defineAgent({ options: {}, configure: () => ${result} })`
  await expect(discover(source)).rejects.toThrow("cannot inspect a configure result factory")
  for (const workspace of ['{}', '"shared"']) {
    const definitions = await discover(source.replace("options: {}", `options: {}, workspace: ${workspace}`))
    expect(definitions[0]?.workspace).toBe(workspace === '{}' ? "notes" : undefined)
  }
})

it.each([
  '...importedSettings',
  '...namespace.settings',
  '...alias',
  '...{ ...importedSettings }',
])("rejects opaque Agent settings spreads: %s", async (settings) => {
  const source = `import importedSettings from "./settings"; import * as namespace from "./settings"; const alias = importedSettings; export default defineAgent({ options: {}, configure: () => defineAgent({ ${settings} }) })`
  await expect(discover(source)).rejects.toThrow("cannot inspect opaque Agent settings")
  for (const workspace of ['{}', '"shared"']) {
    const definitions = await discover(source.replace(settings, `${settings}, workspace: ${workspace}`))
    expect(definitions[0]?.workspace).toBe(workspace === '{}' ? "notes" : undefined)
  }
})

it("inspects local settings spreads and respects local import shadowing", async () => {
  const definitions = await discover('import settings from "./settings"; export default defineAgent({ options: {}, configure: () => { const settings = { workspace: {} }; return defineAgent({ ...settings }) } })')
  expect(definitions[0]?.workspace).toBe("notes")
  const plain = await discover('const settings = { description: "plain" }; export default defineAgent({ options: {}, configure: () => defineAgent({ ...settings }) })')
  expect(plain[0]?.workspace).toBeUndefined()
})

it.each([
  'build!()',
  'build?.()',
  'builders?.["workspace"]()',
  '(build as Factory)()',
  '(build satisfies Factory)()',
  '(build as (() => Agent))()',
  '(build)!()',
  'builders["workspace"]!()',
])("rejects asserted configure result factories: %s", async (result) => {
  const source = `const build = () => defineAgent({ workspace: {} }); const builders = { workspace: build }; export default defineAgent({ options: {}, configure: () => ${result} })`
  await expect(discover(source)).rejects.toThrow("cannot inspect a configure result factory")
  for (const workspace of ['{}', '"shared"']) {
    const definitions = await discover(source.replace("options: {}", `options: {}, workspace: ${workspace}`))
    expect(definitions[0]?.workspace).toBe(workspace === '{}' ? "notes" : undefined)
  }
})

it.each([
  '({ key }) => defineAgent({ [key]: {} })',
  'options => defineAgent({ [options.key]: {} })',
])("rejects opaque computed settings keys: %s", async (configure) => {
  const source = `export default defineAgent({ options: { key: "workspace" }, configure: ${configure} })`
  await expect(discover(source)).rejects.toThrow("cannot inspect a computed Agent settings key")
  for (const workspace of ['{}', '"shared"']) {
    const definitions = await discover(source.replace('options:', `workspace: ${workspace}, options:`))
    expect(definitions[0]?.workspace).toBe(workspace === '{}' ? "notes" : undefined)
  }
})

it.each(['options.workspaceName', 'options["workspaceName"]'])("rejects ambiguous option Workspace values: %s", async (workspace) => {
  const source = `export default defineAgent({ options: { workspaceName: "shared" }, configure: options => defineAgent({ workspace: ${workspace} }) })`
  await expect(discover(source)).rejects.toThrow("cannot inspect a dynamic Workspace value")
  for (const marker of ['{}', '"shared"']) {
    const definitions = await discover(source.replace('options:', `workspace: ${marker}, options:`))
    expect(definitions[0]?.workspace).toBe(marker === '{}' ? "notes" : undefined)
  }
})


it("rejects a destructured option Workspace reference", async () => {
  await expect(discover('export default defineAgent({ options: { workspaceName: "shared" }, configure: ({ workspaceName }) => defineAgent({ workspace: workspaceName }) })')).rejects.toThrow("cannot inspect a dynamic Workspace value")
})
