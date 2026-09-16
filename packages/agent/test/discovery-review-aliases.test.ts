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
  ['import { defineCapability as capability } from "@vite-hub/agent"', '() => { const capability = () => ({}); return defineAgent({ capabilities: [capability({ workspace: {} })] }) }'],
  ['import * as hub from "@vite-hub/agent"', '() => { const hub = {}; return defineAgent({ capabilities: [hub.defineCapability({ workspace: {} })] }) }'],
])("honors shadowed Capability factories: %s", async (imports, configure) => {
  await expect(workspaceFor(`${imports}; export default defineAgent({ options: {}, configure: ${configure} })`)).resolves.toBeUndefined()
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
])("honors shadowed Channel factories: %s", async (configure) => {
  await expect(workspaceFor(`import { defineChannel } from "@vite-hub/agent/channels"; const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: ${configure} })`)).resolves.toBeUndefined()
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
  await expect(workspaceFor('import { defineChannel } from "other-package"; const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: () => defineAgent({ channels: { custom: defineChannel("custom", { capabilities: [storage] }) } }) })')).resolves.toBeUndefined()
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
