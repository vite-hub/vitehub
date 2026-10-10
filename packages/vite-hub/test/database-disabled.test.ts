import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { runViteHubCli } from "@vite-hub/cli"
import { hubDb } from "@vite-hub/database/vite"
import { build, resolveConfig, type InlineConfig, type Plugin, type PluginOption } from "vite"
import { afterEach, describe, expect, it } from "vitest"

import { vitehub } from "../src/index.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createProject(files: Record<string, string>): Promise<string> {
  // Inside the package so the server entry resolves the workspace Database package.
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

describe("vitehub() without database", () => {
  it.each(["vite-hub/database/drizzle", "@vite-hub/database/drizzle"])("fails the build when server code imports %s", async (specifier) => {
    const root = await createProject({
      "server/databases/config.ts": databaseDefinition,
      "src/server.ts": `import { useDatabase } from ${JSON.stringify(specifier)}\nexport const notes = useDatabase("default")\n`,
    })

    await expect(build(serverBuild(root, vitehub({ preset: "node", env: false }))))
      .rejects.toThrow(`Database is disabled but ${JSON.stringify(join(root, "src/server.ts"))} imports ${JSON.stringify(specifier)}. Set \`database: true\` in vitehub() to enable Database.`)
  })

  it("builds the same import when Database is enabled", async () => {
    const root = await createProject({
      "server/databases/config.ts": databaseDefinition,
      "src/server.ts": `import { useDatabase } from "vite-hub/database/drizzle"\nexport const notes = useDatabase("default")\n`,
    })

    await expect(build(serverBuild(root, vitehub({ preset: "node", database: true, env: false })))).resolves.toBeDefined()
  }, 30_000)

  it("lets an explicitly composed Database integration provide the runtime", async () => {
    const root = await createProject({ "server/databases/config.ts": databaseDefinition })
    // SAFETY: Both packages use the same Vite API, but pnpm resolves separate peer type instances.
    const databasePlugin = hubDb() as unknown as Plugin
    const plugins = [vitehub({ preset: "node", env: false }), databasePlugin]
    const config = await resolveConfig(serverBuild(root, plugins), "build")
    const guard = config.plugins.find(plugin => plugin.name === "vite-hub/database-disabled")
    const resolveId = guard?.resolveId
    if (typeof resolveId !== "function") throw new TypeError("Expected the disabled Database guard.")
    // SAFETY: The guard reads only the import source and importer.
    expect(resolveId.call({} as never, "vite-hub/database/drizzle", join(root, "src/server.ts"), {} as never)).toBeUndefined()
    expect((await runDb(root, plugins, ["db", "--help"])).stdout).toContain("generate")
  })

  it("lets a composed Database integration without Definitions provide the runtime", async () => {
    const root = await createProject({})

    // SAFETY: Both packages use the same Vite API, but pnpm resolves separate peer type instances.
    const databasePlugin = hubDb() as unknown as Plugin
    const plugins = [vitehub({ preset: "node", env: false }), databasePlugin]
    const config = await resolveConfig(serverBuild(root, plugins), "build")
    const guard = config.plugins.find(plugin => plugin.name === "vite-hub/database-disabled")
    const resolveId = guard?.resolveId
    if (typeof resolveId !== "function") throw new TypeError("Expected the disabled Database guard.")
    // SAFETY: The guard reads only the import source and importer.
    expect(resolveId.call({} as never, "vite-hub/database/drizzle", join(root, "src/server.ts"), {} as never)).toBeUndefined()
  })

  it("reports imports when a composed Database integration is explicitly disabled", async () => {
    const root = await createProject({
      "src/server.ts": `import { useDatabase } from "vite-hub/database/drizzle"\nexport const notes = useDatabase("default")\n`,
    })

    // SAFETY: Both packages use the same Vite API, but pnpm resolves separate peer type instances.
    const databasePlugin = hubDb() as unknown as Plugin
    const plugins = [vitehub({ preset: "node", database: false, env: false }), databasePlugin]
    await expect(build(serverBuild(root, plugins))).rejects.toThrow(
      `Database is disabled but ${JSON.stringify(join(root, "src/server.ts"))} imports "vite-hub/database/drizzle". Set \`database: true\` in vitehub() to enable Database.`,
    )
  })

  it("explains the db commands when Database Definitions exist", async () => {
    const root = await createProject({ "server/databases/config.ts": databaseDefinition })
    const plugins = vitehub({ preset: "node", env: false })

    const help = await runDb(root, plugins, ["db", "--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("Database is disabled. Set `database: true` in vitehub() to enable Database.")

    const generate = await runDb(root, plugins, ["db", "generate"])
    expect(generate.exitCode).toBe(1)
    expect(generate.stderr).toBe("[vitehub] Database is disabled, so ViteHub ignores the discovered Database Definitions. Set `database: true` in vitehub() to enable Database.\n")
  })

  it("adds no db commands when the project defines no Database", async () => {
    const root = await createProject({ "src/server.ts": "export {}\n" })
    const result = await runDb(root, vitehub({ preset: "node", env: false }), ["db", "--help"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unknown ViteHub CLI namespace: db")
  })
})
