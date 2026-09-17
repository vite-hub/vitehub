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

it.each(["values.storage", 'values["storage"]', "values[key]", "values?.storage"])("rejects opaque local Capability members: %s", async (member) => {
  const source = `const storage = defineCapability({ workspace: {} }); const values = { storage }; const key = "storage"; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: [${member}] }) })`
  await expect(discover(source)).rejects.toThrow("cannot inspect a local Capability member")
  const definitions = await discover(source.replace("capabilities:", "workspace: {}, capabilities:"))
  expect(definitions[0]?.workspace).toBe("notes")
})

it.each(["values.storage()", 'values["storage"]()', "values[key]()", "values?.storage()", "values.storage?.()", "values?.[key]?.()"])("rejects opaque local Capability member calls: %s", async (member) => {
  const source = `const values = { storage: () => defineCapability({ workspace: {} }) }; const key = "storage"; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: [${member}] }) })`
  await expect(discover(source)).rejects.toThrow("cannot inspect a local Capability member")
  const definitions = await discover(source.replace("capabilities:", "workspace: {}, capabilities:"))
  expect(definitions[0]?.workspace).toBe("notes")
})

it("rejects callback parameters that shadow imported Capabilities", async () => {
  await expect(discover('import { storage } from "./storage"; export default defineAgent({ options: {}, configure: storage => defineAgent({ capabilities: [storage] }) })')).rejects.toThrow("option-derived Capability expression")
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
    await expect(discover(source.replace(settings, `workspace: ${workspace}, ${settings}`))).rejects.toThrow("cannot inspect opaque Agent settings")
    await expect(discover(`import importedSettings from "./settings"; import * as namespace from "./settings"; const alias = importedSettings; export default defineAgent({ workspace: ${workspace}, ${settings} })`)).rejects.toThrow("cannot inspect opaque Agent settings")
  }
})

it("preserves Workspace overrides inside nested opaque spreads", async () => {
  const definitions = await discover('import settings from "./settings"; export default defineAgent({ workspace: "shared", ...{ ...settings, workspace: {} } })')
  expect(definitions[0]?.workspace).toBe("notes")
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
  'build?.<Agent>()',
  'builders.workspace?.<Agent>()',
  'builders?.["workspace"]?.<Agent>()',
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
  '() => { const key = "workspace"; return defineAgent({ [`${key}`]: {} }) }',
  '() => { const key = `work${"space"}`; return defineAgent({ [key]: {} }) }',
  '() => defineAgent({ [`work\\u0073pace`]: {} })',
  '() => { const key = `work\\x73pace`; return defineAgent({ [key]: {} }) }',
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

it.each([String.raw`"\x77orkspace"`, String.raw`'\u{77}orkspace'`, String.raw`["\x77orkspace"]`])("rejects unsupported escaped settings keys: %s", async (key) => {
  await expect(discover(`export default defineAgent({ options: {}, configure: () => defineAgent({ ${key}: {} }) })`)).rejects.toThrow("cannot inspect an escaped settings key")
})

it.each(["void 0 || {}", "void 0 ?? {}", "void 0 ? {} : {}"])("rejects compound void Workspace expressions: %s", async (workspace) => {
  await expect(discover(`export default defineAgent({ options: {}, configure: () => defineAgent({ workspace: ${workspace} }) })`)).rejects.toThrow("cannot inspect a compound void expression")
})

it.each([
  '() => ({ kind: "custom", capabilities: [storage] })',
  '(options) => ({ kind: "custom", capabilities: [storage] })',
  'function custom() { return { kind: "custom", capabilities: [storage] } }',
])("requires a Workspace marker for local Channel factories: %s", async (factory) => {
  const declaration = `const storage = defineCapability({ workspace: {} }); const custom = ${factory};`
  for (const channel of [factory, "custom"]) {
    const settings = `options: {}, configure: () => defineAgent({ channels: { custom: ${channel} } })`
    await expect(discover(`${declaration} export default defineAgent({ ${settings} })`)).rejects.toThrow("cannot inspect a local Channel factory")
    const definitions = await discover(`${declaration} export default defineAgent({ workspace: {}, ${settings} })`)
    expect(definitions[0]?.workspace).toBe("notes")
  }
})

it.each(["Array.of(storage)", "Array.from([storage])", "Array['of'](storage)", "Array(storage)", "new Array(storage)"])("requires a Workspace marker for constructed Capability lists: %s", async (capabilities) => {
  const declaration = `const storage = defineCapability({ workspace: {} }); const list = ${capabilities};`
  for (const value of [capabilities, "list"]) {
    const settings = `options: {}, configure: () => defineAgent({ capabilities: ${value} })`
    await expect(discover(`${declaration} export default defineAgent({ ${settings} })`)).rejects.toThrow("cannot inspect an opaque Capability expression")
    const definitions = await discover(`${declaration} export default defineAgent({ workspace: {}, ${settings} })`)
    expect(definitions[0]?.workspace).toBe("notes")
  }
})

it.each(["custom", '["custom"]'])("requires a Workspace marker for Channel method %s", async (key) => {
  const declaration = "const storage = defineCapability({ workspace: {} });"
  const settings = `options: {}, configure: () => defineAgent({ channels: { ${key}() { return { kind: "custom", capabilities: [storage] } } } })`
  await expect(discover(`${declaration} export default defineAgent({ ${settings} })`)).rejects.toThrow("cannot inspect a local Channel factory")
  const definitions = await discover(`${declaration} export default defineAgent({ workspace: {}, ${settings} })`)
  expect(definitions[0]?.workspace).toBe("notes")
})


it.each([
  ['import { github } from "vite-hub/agent/channels"', 'github({ pullRequest: true })'],
  ['import { github as gh } from "@vite-hub/agent/channels"', 'gh({ pullRequest: true })'],
  ['import * as channels from "vite-hub/agent/channels"', 'channels.github({ pullRequest: true })'],
  ['import { github } from "vite-hub/agent/channels"; const factory = github', 'factory({ pullRequest: true })'],
  ['import { defineChannel } from "vite-hub/agent/channels"; const options = () => ({ capabilities: [defineCapability({ workspace: {} })] })', 'defineChannel("custom", options())'],
  ['const factory = () => ({ kind: "custom", capabilities: [defineCapability({ workspace: {} })] })', 'factory()'],
])("requires a Workspace marker for opaque Channel calls: %s", async (imports, value) => {
  for (const channel of [value, "custom"]) {
    const settings = `options: {}, configure: () => defineAgent({ channels: { custom: ${channel} } })`
    const source = `${imports}; const custom = ${value};`
    await expect(discover(`${source} export default defineAgent({ ${settings} })`)).rejects.toThrow(/cannot inspect .*Channel/)
    const definitions = await discover(`${source} export default defineAgent({ workspace: {}, ${settings} })`)
    expect(definitions[0]?.workspace).toBe("notes")
  }
})


it.each(['defineChannel("custom")', 'defineChannel("custom", undefined)', 'defineChannel("custom", {})', 'defineChannel("custom", options)'])("inspects supported Channel constructor options: %s", async (channel) => {
  const definitions = await discover(`import { defineChannel } from "vite-hub/agent/channels"; const options = {}; export default defineAgent({ options: {}, configure: () => defineAgent({ channels: { custom: ${channel} } }) })`)
  expect(definitions[0]?.workspace).toBeUndefined()
})
