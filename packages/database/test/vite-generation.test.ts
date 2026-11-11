import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"
import * as definitionCatalog from "@vite-hub/internal/definition-catalog"

import { resolveDBViteConfig } from "../src/config.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"
import { DB_VIRTUAL_DATABASES_ID, DB_VIRTUAL_SCHEMA_ID, hubDatabase } from "../src/vite.ts"

vi.mock("../src/internal/generated.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/internal/generated.ts")>(),
  writeGeneratedDatabaseArtifacts: vi.fn(),
}))

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-db-generation-"))
  tempDirs.push(root)
  const definition = join(root, "server/databases/default.ts")
  await mkdir(dirname(definition), { recursive: true })
  await writeFile(definition, "export default { schema: { notes: {} } }\n")
  return { definition, root }
}

function hooks(plugin: ReturnType<typeof hubDatabase>) {
  // SAFETY: The tests call the Database plugin's Vite hooks with the fields those hooks use.
  return {
    configResolved: plugin.configResolved as (config: unknown) => Promise<void>,
    hotUpdate: plugin.handleHotUpdate as (context: unknown) => Promise<void>,
    load: (plugin.load as { handler: (id: string) => Promise<string> }).handler,
  }
}

it("serializes startup and hot-update writes and waits for the latest artifacts before loading or invalidating", async () => {
  const { definition, root } = await createProject()
  const started = [deferred(), deferred()]
  const release = [deferred(), deferred()]
  let generation = 0
  vi.mocked(writeGeneratedDatabaseArtifacts).mockImplementation(async (config) => {
    const index = generation++
    started[index]!.resolve()
    await release[index]!.promise
    const schema = config.generatedSchemaFilesByDatabase.default!
    await mkdir(dirname(schema), { recursive: true })
    await writeFile(schema, `export const ${index === 0 ? "notes" : "tasks"} = {}\n`)
  })

  const plugin = hubDatabase()
  const { configResolved, hotUpdate, load } = hooks(plugin)
  await configResolved({ command: "serve", root })
  await started[0]!.promise

  const ids = [DB_VIRTUAL_SCHEMA_ID, DB_VIRTUAL_DATABASES_ID].map(id => `\0${id}`)
  let loaded = false
  // These loads start before the newer generation is queued.
  const modules = Promise.all(ids.map(load)).then(result => { loaded = true; return result })
  await writeFile(definition, "export default { schema: { tasks: {} } }\n")
  const invalidateModule = vi.fn()
  const update = hotUpdate({
    file: definition,
    server: { moduleGraph: { getModuleById: (id: string) => ({ id }), invalidateModule } },
  })
  const latestModules = Promise.all(ids.map(load))

  try {
    expect(writeGeneratedDatabaseArtifacts).toHaveBeenCalledTimes(1)
    release[0]!.resolve()
    await started[1]!.promise
    expect(loaded).toBe(false)
    expect(invalidateModule).not.toHaveBeenCalled()
    release[1]!.resolve()
    await update
    await expect(modules).resolves.toEqual(await latestModules)
    const schema = plugin.api.getConfig()!.generatedSchemaFilesByDatabase.default!
    await expect(readFile(schema, "utf8")).resolves.toBe("export const tasks = {}\n")
    expect(invalidateModule.mock.calls.map(([module]) => module.id)).toContain(schema)
    expect(invalidateModule.mock.calls.map(([module]) => module.id)).toEqual(expect.arrayContaining(ids))
  }
  finally {
    release.forEach(gate => gate.resolve())
    await Promise.allSettled([update, modules, latestModules])
  }
})

it("reports a failed startup generation and allows a later refresh to recover", async () => {
  const { root } = await createProject()
  const failure = new Error("schema generation failed")
  vi.mocked(writeGeneratedDatabaseArtifacts).mockRejectedValueOnce(failure).mockResolvedValue(undefined)
  const error = vi.fn()
  const plugin = hubDatabase()
  const { configResolved, load } = hooks(plugin)
  await configResolved({ command: "serve", logger: { error }, root })
  await expect(load(`\0${DB_VIRTUAL_SCHEMA_ID}`)).rejects.toThrow(failure)
  expect(error).toHaveBeenCalledWith(failure.message)

  await plugin.api.refresh()
  await expect(load(`\0${DB_VIRTUAL_SCHEMA_ID}`)).resolves.toContain("export * from")
  expect(writeGeneratedDatabaseArtifacts).toHaveBeenCalledTimes(2)
})

it.each(["schema", "config"] as const)("finishes sibling %s writes before rejecting a generation", async (phase) => {
  const { definition, root } = await createProject()
  await rm(definition)
  for (const name of ["first", "second"]) {
    const file = join(root, `server/databases/${name}/index.ts`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `function defineDatabase(value) { return value }\nexport default defineDatabase({ name: '${name}', schema: {} })\n`)
  }
  const config = resolveDBViteConfig(undefined, root)!
  const paths = phase === "schema" ? config.generatedSchemaFilesByDatabase : config.generatedDrizzleConfigFilesByDatabase
  const failed = deferred()
  const blocked = deferred()
  const finished = deferred()
  const release = deferred()
  const failure = new Error("artifact write failed")
  const write = definitionCatalog.writeFileIfChanged
  vi.spyOn(definitionCatalog, "writeFileIfChanged").mockImplementation(async (file, contents) => {
    if (file === paths.first) {
      failed.resolve()
      throw failure
    }
    if (file === paths.second) {
      blocked.resolve()
      await release.promise
      try {
        await write(file, contents)
      }
      finally {
        finished.resolve()
      }
      return
    }
    await write(file, contents)
  })
  const { writeGeneratedDatabaseArtifacts: writeArtifacts } = await vi.importActual<typeof import("../src/internal/generated.ts")>("../src/internal/generated.ts")
  let settled = false
  const result = writeArtifacts(config).then(
    () => { settled = true },
    (error: unknown) => { settled = true; return error },
  )
  try {
    await Promise.all([failed.promise, blocked.promise])
    await new Promise<void>(done => setImmediate(done))
    expect(settled).toBe(false)
    release.resolve()
    await expect(result).resolves.toBe(failure)
    await expect(readFile(paths.second!, "utf8")).resolves.toContain("export")
  }
  finally {
    release.resolve()
    await result
    await finished.promise
  }
})
