import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runViteHubCli } from "@vite-hub/cli"
import { hubDatabase } from "@vite-hub/database/vite"
import { build, resolveConfig, type InlineConfig, type Plugin, type PluginOption } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { vitehub } from "../src/index.ts"

const roots: string[] = []
const enableExplicitly = "Set `database: true`, or remove `database: false` and use a Database Definition in `server/databases/`, to enable Database."

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(import.meta.dirname, ".database-disabled-"))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), content)
  }
  return root
}

const databaseDefinition = [
  `import { defineDatabase } from "vite-hub/database"`,
  `import { integer, sqliteTable } from "drizzle-orm/sqlite-core"`,
  `export default defineDatabase({ schema: { notes: sqliteTable("notes", { id: integer("id").primaryKey() }) } })`,
  "",
].join("\n")

function serverBuild(root: string, plugins: PluginOption[]): InlineConfig {
  return {
    appType: "custom",
    build: { outDir: "dist", rolldownOptions: { input: join(root, "src/server.ts") }, ssr: true, write: false },
    configFile: false,
    logLevel: "silent",
    plugins,
    root,
  }
}

async function runDb(root: string, plugins: PluginOption[], args: string[]) {
  let stderr = ""
  let stdout = ""
  const exitCode = await runViteHubCli({
    args,
    cwd: root,
    loadConfig: async (directory, command) => ({
      ...await resolveConfig(serverBuild(directory, plugins), command),
      vitehubConfigResolved: true,
    }),
    stderr: { write: chunk => (stderr += String(chunk), true) },
    stdout: { write: chunk => (stdout += String(chunk), true) },
  })
  return { exitCode, stderr, stdout }
}

describe("vitehub() and the database option", () => {
  it.each(["vite-hub/database", "@vite-hub/database"])("fails the build when server code imports %s", async (specifier) => {
    const root = await createProject({
      "src/server.ts": `import { useDatabase } from ${JSON.stringify(specifier)}\nexport const notes = useDatabase("default")\n`,
    })

    await expect(build(serverBuild(root, vitehub({ host: "node", env: false }))))
      .rejects.toThrow(`Database is disabled but ${JSON.stringify(join(root, "src/server.ts"))} imports ${JSON.stringify(specifier)}. Add a Database Definition in \`server/databases/\`, or set \`database: true\` in vitehub(), to enable Database.`)
  })

  it("turns Database on from a Database Definition without the option", async () => {
    const root = await createProject({
      "package.json": "{}\n",
      "server/databases/default.ts": databaseDefinition,
      "src/server.ts": `import { useDatabase } from "vite-hub/database"\nexport const notes = useDatabase("default")\n`,
    })
    const plugins = vitehub({ host: "node", env: false })

    await expect(build(serverBuild(root, plugins))).resolves.toBeDefined()
    expect((await runDb(root, plugins, ["database", "--help"])).stdout).toContain("generate")
  }, 30_000)

  it("uses the Vite root and ignores seeds and migration sources", async () => {
    const root = await createProject({
      "package.json": "{}\n",
      "server/databases/default.ts": databaseDefinition,
      "app/server/databases/default/seed.ts": "export {}\n",
      "app/server/databases/default/migrations/old.ts": "export {}\n",
    })
    vi.spyOn(process, "cwd").mockReturnValue(root)
    const app = join(root, "app")
    const options = serverBuild(app, vitehub({ host: "node", env: false }))
    const owners = async () => (await resolveConfig(options, "build")).plugins.filter(plugin => plugin.name === "@vite-hub/database/vite")
    expect(await owners()).toHaveLength(0)
    await writeFile(join(app, "server/databases/default.ts"), databaseDefinition)
    const [owner] = await owners()
    const api = owner?.api as ReturnType<typeof hubDatabase>["api"] | undefined
    expect(api?.getConfig()?.definitions).toContainEqual(expect.objectContaining({ handler: join(app, "server/databases/default.ts"), tableNames: ["notes"] }))
  })

  it("keeps a directly composed owner's connection and CLI options with a Definition", async () => {
    const root = await createProject({ "server/databases/default.ts": databaseDefinition })
    vi.spyOn(process, "cwd").mockReturnValue(root)
    const owner = hubDatabase({ connection: { url: "file:custom.sqlite" }, cli: { generate: false } })
    const plugins = [vitehub({ host: "node", env: false }), owner as unknown as Plugin]
    const config = await resolveConfig(serverBuild(root, plugins), "build")
    expect(config.plugins.filter(plugin => plugin.name === owner.name)).toEqual([owner])
    expect(owner.api.getConfig()?.databases.default?.connection?.url).toBe("file:custom.sqlite")
    const help = await runDb(root, plugins, ["database", "--help"])
    expect(help.stdout).toContain("migrate")
    expect(help.stdout).not.toContain("generate")
  })

  it("keeps Database off with `database: false` and a Database Definition", async () => {
    const root = await createProject({
      "package.json": "{}\n",
      "server/databases/default.ts": databaseDefinition,
      "src/server.ts": `import { useDatabase } from "vite-hub/database"\nexport const notes = useDatabase("default")\n`,
    })
    vi.spyOn(process, "cwd").mockReturnValue(root)

    await expect(build(serverBuild(root, vitehub({ host: "node", database: false, env: false }))))
      .rejects.toThrow(`Database is disabled but ${JSON.stringify(join(root, "src/server.ts"))} imports "vite-hub/database". ${enableExplicitly}`)
  })

  it("builds the same import when Database is enabled", async () => {
    const root = await createProject({
      "server/databases/default.ts": databaseDefinition,
      "src/server.ts": `import { useDatabase } from "vite-hub/database"\nexport const notes = useDatabase("default")\n`,
    })

    await expect(build(serverBuild(root, vitehub({ host: "node", database: true, env: false })))).resolves.toBeDefined()
  }, 30_000)

  it("lets an explicitly composed Database integration provide the runtime", async () => {
    const root = await createProject({ "src/server.ts": "export {}\n" })
    // SAFETY: Both packages use the same Vite API, but pnpm resolves separate peer type instances.
    const databasePlugin = hubDatabase() as unknown as Plugin
    const plugins = [vitehub({ host: "node", env: false }), databasePlugin]
    const config = await resolveConfig(serverBuild(root, plugins), "build")
    const guard = config.plugins.find(plugin => plugin.name === "vite-hub/database-disabled")
    const resolveId = guard?.resolveId && "handler" in guard.resolveId ? guard.resolveId.handler : undefined
    if (!resolveId) throw new TypeError("Expected the disabled Database guard.")
    // SAFETY: The guard reads only the import source and importer.
    expect(resolveId.call({} as never, "vite-hub/database", join(root, "src/server.ts"), {} as never)).toBeUndefined()
  })

  it("lets a composed Database integration without Definitions provide the runtime", async () => {
    const root = await createProject({})

    // SAFETY: Both packages use the same Vite API, but pnpm resolves separate peer type instances.
    const databasePlugin = hubDatabase() as unknown as Plugin
    const plugins = [vitehub({ host: "node", env: false }), databasePlugin]
    const config = await resolveConfig(serverBuild(root, plugins), "build")
    const guard = config.plugins.find(plugin => plugin.name === "vite-hub/database-disabled")
    const resolveId = guard?.resolveId && "handler" in guard.resolveId ? guard.resolveId.handler : undefined
    if (!resolveId) throw new TypeError("Expected the disabled Database guard.")
    // SAFETY: The guard reads only the import source and importer.
    expect(resolveId.call({} as never, "vite-hub/database", join(root, "src/server.ts"), {} as never)).toBeUndefined()
  })

  it("reports imports when a composed Database integration is explicitly disabled", async () => {
    const root = await createProject({
      "src/server.ts": `import { useDatabase } from "vite-hub/database"\nexport const notes = useDatabase("default")\n`,
    })

    // SAFETY: Both packages use the same Vite API, but pnpm resolves separate peer type instances.
    const databasePlugin = hubDatabase() as unknown as Plugin
    const plugins = [vitehub({ host: "node", database: false, env: false }), databasePlugin]
    await expect(build(serverBuild(root, plugins))).rejects.toThrow(
      `Database is disabled but ${JSON.stringify(join(root, "src/server.ts"))} imports "vite-hub/database". ${enableExplicitly}`,
    )
  })

  it("explains the db commands when `database: false` hides Database Definitions", async () => {
    const root = await createProject({ "server/databases/default.ts": databaseDefinition })
    vi.spyOn(process, "cwd").mockReturnValue(root)
    const plugins = vitehub({ host: "node", database: false, env: false })

    const help = await runDb(root, plugins, ["database", "--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain(`Database is disabled. ${enableExplicitly}`)

    const generate = await runDb(root, plugins, ["database", "generate"])
    expect(generate.exitCode).toBe(1)
    expect(generate.stderr).toBe(`[vitehub] Database is disabled, so ViteHub ignores the discovered Database Definitions. ${enableExplicitly}\n`)
  })

  it("adds no database commands when the project defines no Database", async () => {
    const root = await createProject({ "src/server.ts": "export {}\n" })
    const result = await runDb(root, vitehub({ host: "node", env: false }), ["database", "--help"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unknown ViteHub CLI namespace: database")
  })
})
