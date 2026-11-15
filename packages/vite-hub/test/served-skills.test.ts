import { ownModule } from "@vite-hub/internal/build/paths"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { collectOperationContributions, operationCliPath, operationsOf } from "@vite-hub/internal/operations"
import { describeViteHubConsoleSection } from "@vite-hub/internal/console"

import { discoverConsoleBuildCatalog, withConsoleDocumentEditorSections } from "../src/console/build.ts"
import { operationSwitchCall } from "../src/console/runtime/client/operation-view.ts"
import { parseConsoleContributedSection } from "../src/console/runtime/definitions.ts"
import { defineSkill, skillSettings } from "../src/skills.ts"
import { servedSkillsConsoleSection } from "../src/skills/console.ts"
import { servedSkillsOperations } from "../src/skills/operations.ts"
import { servedSkillsRegistryKey } from "../src/skills/registry.ts"
import { viteHubServedSkillsPlugin } from "../src/skills/vite.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { SkillSettingsStore } from "../src/skills.ts"

const scope = globalThis as Record<symbol, unknown>
const registryKey = Symbol.for(servedSkillsRegistryKey)
const context: OperationContext = { access: { mode: "local", sections: "all" }, surface: "cli", user: null }
const roots: string[] = []

const release = defineSkill({ "SKILL.md": "---\nname: release\ndescription: Ship a release.\n---\n", "references/checklist.md": "# Checklist\n" })
const handoff = defineSkill({ "SKILL.md": "---\nname: handoff\ndescription: Hand work over.\n---\n" })

afterEach(async () => {
  Reflect.deleteProperty(scope, registryKey)
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-served-skills-"))
  roots.push(root)
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), contents)
  }
  return root
}

async function runConfigHook(root: string) {
  const plugin = viteHubServedSkillsPlugin()
  const config: { nitro?: unknown, root: string } = { root }
  const hook = plugin.config
  if (typeof hook !== "function") throw new TypeError("The skills plugin has no config hook.")
  await hook.call({} as never, config as never, { command: "build", mode: "production" })
  return { config, plugin }
}

function call(name: string, input: unknown): Promise<unknown> {
  const operation = servedSkillsOperations.find(candidate => candidate.name === name)
  if (!operation) throw new TypeError(`No operation ${name}.`)
  return Promise.resolve((operation.run as (input: unknown, context: OperationContext) => unknown)(input, context))
}

function memoryStore(): SkillSettingsStore & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    get: async key => [undefined, values.get(key) ?? null],
    set: async (key, value) => {
      values.set(key, value)
      return [undefined, undefined]
    },
    values,
  }
}

describe("viteHubServedSkillsPlugin", () => {
  it("hands server/skills.ts to the operations and contributes them only when the file exists", async () => {
    const root = await project({ "server/skills.ts": "export default []\n" })
    const { config, plugin } = await runConfigHook(root)
    const registry = join(root, ".vitehub/nitro/skills/registry.mjs")
    expect(config.nitro).toMatchObject({ plugins: [registry] })
    expect(await readFile(registry, "utf8")).toContain(`import(${JSON.stringify(pathToFileURL(join(root, "server/skills.ts")).href)})`)
    const [contribution] = await collectOperationContributions([plugin])
    expect(contribution).toMatchObject({ export: "servedSkillsOperations", module: ownModule(import.meta.url, "skills/operations") })
    expect(operationsOf(await contribution?.load?.()).map(operation => operation.name)).toEqual(["served-skills.list", "served-skills.set"])

    const without = await runConfigHook(await project({}))
    expect(without.config.nitro).toBeUndefined()
    await expect(collectOperationContributions([without.plugin])).resolves.toEqual([])
  })

  it("adds the Served skills Console section when the app has server/skills.ts", async () => {
    const root = await project({ "server/.keep": "" })
    const discover = () => discoverConsoleBuildCatalog({ discoveryRoot: root, plugins: [], projectRoot: root, sections: ["env"] })
    expect(withConsoleDocumentEditorSections(["env"], await discover())).toEqual(["env"])
    await writeFile(join(root, "server", "skills.ts"), "export default []\n")
    const catalog = await discover()
    expect(withConsoleDocumentEditorSections(["env"], catalog)).toContain("served-skills")
    expect(catalog.content["served-skills"]).toEqual({ kind: "operation-view" })
    expect(catalog.sectionOverrides?.["served-skills"]).toMatchObject({ id: "served-skills", view: { operation: "served-skills.list" } })
  })
})

describe("served-skills operations", () => {
  it("names served-skills.list and served-skills.set under `vitehub served-skills`", () => {
    expect(servedSkillsOperations.map(({ kind, name, section }) => ({ kind, name, section }))).toEqual([
      { kind: "read", name: "served-skills.list", section: "served-skills" },
      { kind: "write", name: "served-skills.set", section: "served-skills" },
    ])
    expect(servedSkillsOperations.map(operationCliPath)).toEqual([{ command: "list", namespace: "served-skills" }, { command: "set", namespace: "served-skills" }])
  })

  it("lists and switches the skills of skillSettings()", async () => {
    const store = memoryStore()
    scope[registryKey] = async () => ({ default: skillSettings([release, handoff], { store }) })
    expect(await call("served-skills.list", {})).toEqual([
      { description: "Ship a release.", enabled: true, files: 2, id: "release", name: "release" },
      { description: "Hand work over.", enabled: true, files: 1, id: "handoff", name: "handoff" },
    ])
    expect(await call("served-skills.set", { enabled: false, name: "release" })).toMatchObject({ enabled: false, name: "release" })
    expect(store.values.get("vitehub:skills:disabled")).toEqual(["release"])
    expect(await call("served-skills.list", {})).toMatchObject([{ enabled: false, name: "release" }, { enabled: true, name: "handoff" }])
    await expect(call("served-skills.set", { enabled: false, name: "missing" })).rejects.toMatchObject({ code: "SKILL_NOT_FOUND", status: 404 })
  })

  it("lists a plain skill list as on, and refuses to switch it", async () => {
    scope[registryKey] = async () => ({ skills: [release] })
    expect(await call("served-skills.list", {})).toMatchObject([{ enabled: true, name: "release" }])
    await expect(call("served-skills.set", { enabled: false, name: "release" })).rejects.toMatchObject({ code: "SERVED_SKILLS_NO_SETTINGS", status: 409 })
  })

  it("explains a runtime without server/skills.ts or without a skills export", async () => {
    await expect(call("served-skills.list", {})).rejects.toMatchObject({ code: "SERVED_SKILLS_UNAVAILABLE", status: 503 })
    scope[registryKey] = async () => ({ other: true })
    await expect(call("served-skills.list", {})).rejects.toMatchObject({ code: "SERVED_SKILLS_INVALID_EXPORT", status: 500 })
  })
})

describe("operation view switch column", () => {
  const column = servedSkillsConsoleSection.view.columns.find(entry => entry.format === "switch")!

  it("calls the switch operation with the item values and the new state", () => {
    expect(operationSwitchCall({ enabled: true, name: "release" }, column, false)).toEqual({ input: { enabled: false, name: "release" }, operation: "served-skills.set" })
    expect(operationSwitchCall({ enabled: true }, column, false)).toBeUndefined()
    expect(operationSwitchCall({ name: "release" }, { key: "name", label: "Name" }, false)).toBeUndefined()
  })

  it("keeps the switch when the Console client reads the section, and drops one without an operation", () => {
    const described = JSON.parse(JSON.stringify(describeViteHubConsoleSection(servedSkillsConsoleSection)))
    expect(parseConsoleContributedSection(described)?.view).toMatchObject({ columns: expect.arrayContaining([column]) })
    const broken = { ...described, view: { ...described.view, columns: [{ format: "switch", key: "enabled", label: "On" }] } }
    expect(parseConsoleContributedSection(broken)?.view).toMatchObject({ columns: [{ key: "enabled", label: "On" }] })
    expect(parseConsoleContributedSection(broken)?.view).not.toHaveProperty(["columns", 0, "format"])
  })

  it("needs both the switch format and its operation", () => {
    expect(describeViteHubConsoleSection(servedSkillsConsoleSection).view).toMatchObject({ columns: expect.arrayContaining([column]) })
    const broken = (columns: typeof servedSkillsConsoleSection.view.columns) => () => describeViteHubConsoleSection({ ...servedSkillsConsoleSection, view: { ...servedSkillsConsoleSection.view, columns } })
    expect(broken([{ format: "switch", key: "enabled", label: "On" }])).toThrow(/switch/)
    expect(broken([{ key: "enabled", label: "On", switch: { input: {}, operation: "served-skills.set" } }])).toThrow(/switch/)
    expect(broken([{ format: "switch", key: "enabled", label: "On", switch: { input: {}, operation: "Not An Operation" } }])).toThrow(/switch/)
  })
})
