import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it } from "vitest"

import { useSource } from "../src/index.ts"
import { clearSources } from "../src/internal/registry.ts"
import { prepareSourceGeneration } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  clearSources()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(files: Record<string, string>) {
  const projectRoot = await mkdtemp(join(tmpdir(), "source-files-"))
  roots.push(projectRoot)
  for (const [file, source] of Object.entries(files)) {
    await mkdir(join(projectRoot, file, ".."), { recursive: true })
    await writeFile(join(projectRoot, file), source)
  }
  return projectRoot
}

// Each generated test Source adds its file name here when its module runs.
const evaluatedKey = "__vitehubSourceTestEvaluated"
const evaluated = () => Reflect.get(globalThis, evaluatedKey) ?? []
const trackedSource = (name: string, keys: string[]) => `(globalThis.${evaluatedKey} ??= []).push(${JSON.stringify(name)})
export default { name: ${JSON.stringify(name)}, getKeys: async () => ${JSON.stringify(keys)}, getItem: async key => ({ key, content: "# Intro" }) }
`

afterEach(() => {
  Reflect.deleteProperty(globalThis, evaluatedKey)
})

it("registers each server/sources file by its name and loads it on the first read", async () => {
  const projectRoot = await project({
    "server/sources/custom.mjs": trackedSource("custom", ["intro.md"]),
    "server/sources/team/handbook.mjs": trackedSource("handbook", ["a.md"]),
  })
  const handlers = await prepareSourceGeneration({ projectRoot })
  const registry = join(projectRoot, ".vitehub/source/registry.mjs")
  expect(handlers).toContainEqual({ handler: registry, plugin: true, position: "start" })

  const types = await readFile(join(projectRoot, ".vitehub/types/source/sources.d.ts"), "utf8")
  expect(types).toContain(`"custom": typeof import(${JSON.stringify(join(projectRoot, "server/sources/custom.mjs"))})["default"]`)
  expect(types).toContain(`"team/handbook": typeof import(`)
  expect(await readFile(registry, "utf8")).toContain(`"team/handbook": () => import(${JSON.stringify(pathToFileURL(join(projectRoot, "server/sources/team/handbook.mjs")).href)}),`)

  await import(pathToFileURL(registry).href)
  // Server start and opening a reader evaluate no Source module.
  const reader = useSource("custom")
  expect(evaluated()).toEqual([])

  await expect(reader.get("intro.md")).resolves.toEqual({ key: "intro.md", content: "# Intro" })
  await expect(useSource("custom").keys()).resolves.toEqual(["intro.md"])
  expect(evaluated()).toEqual(["custom"])
})

it("removes the registry when server/sources is empty", async () => {
  const projectRoot = await project({ "server/sources/docs.mjs": "export default { name: 'docs' }\n" })
  await prepareSourceGeneration({ projectRoot })
  await rm(join(projectRoot, "server/sources"), { force: true, recursive: true })
  expect(await prepareSourceGeneration({ projectRoot })).toEqual([])
  await expect(readFile(join(projectRoot, ".vitehub/source/registry.mjs"))).rejects.toThrow()
  await expect(readFile(join(projectRoot, ".vitehub/types/source/sources.d.ts"))).rejects.toThrow()
})

it("fails the build when a Source file has no default export", async () => {
  const projectRoot = await project({ "server/sources/docs.ts": "export const docs = glob({ cwd: 'docs' })\n" })
  await expect(prepareSourceGeneration({ projectRoot })).rejects.toMatchObject({ code: "SOURCE_FILE_DEFAULT_EXPORT_MISSING" })
})

it("fails the build when two server directories define one Source name", async () => {
  const projectRoot = await project({
    "server/sources/docs.ts": "export default {}\n",
    "layer/server/sources/docs.ts": "export default {}\n",
  })
  await expect(prepareSourceGeneration({ projectRoot, serverDirs: ["server", "layer/server"] })).rejects.toMatchObject({ code: "SOURCE_FILE_NAME_DUPLICATE" })
})
