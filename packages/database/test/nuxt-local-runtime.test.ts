import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { build } from "esbuild"
import { describe, expect, it } from "vitest"

import { hubDb } from "../src/nuxt.ts"

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

describe("Nuxt production Node Database runtime", () => {
  it("bundles request middleware without a direct Database dependency", async () => {
    // Stay outside the checkout so the generated import cannot find workspace dependencies.
    const root = await mkdtemp(resolve(packageRoot, "../../../.vitest-nuxt-stats-"))
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
    try {
      await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}')
      await hubDb()(undefined, {
        hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
          if (event === "nitro:config") hooks.push(callback)
        },
        options: { dev: false, nitro: { preset: "node-server" }, rootDir: root, vite: {} },
      })
      for (const hook of hooks) await hook({})
      const output = join(root, "middleware.mjs")
      await build({
        bundle: true,
        entryPoints: [join(root, ".vitehub/nitro/database/request-stats.ts")],
        format: "esm",
        outfile: output,
        platform: "node",
      })
      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", [
        `import middleware from ${JSON.stringify(pathToFileURL(output).href)}`,
        "console.log(middleware({}, () => 42))",
      ].join("\n")], { cwd: root })
      expect(stdout.trim()).toBe("42")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(["default", "orders"])("queries the configured %s SQLite database through the generated host alias", async (name) => {
    const root = await mkdtemp(join(packageRoot, ".vitest-nuxt-node-"))
    const definition = join(root, "server/databases", ...(name === "default" ? [] : [name]), "config.ts")
    const databaseUrl = `file:${join(root, "data", `${name}.sqlite`)}`
    const hooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
    try {
      await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}')
      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, [
        'import { defineDatabase } from "@vite-hub/database"',
        'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"',
        "export default defineDatabase({",
        `  name: ${JSON.stringify(name)},`,
        ...(name === "orders" ? [`  connection: { url: ${JSON.stringify(databaseUrl)} },`] : []),
        '  schema: { users: sqliteTable("users", { id: integer("id").primaryKey(), name: text("name").notNull() }) },',
        "})",
      ].join("\n"))
      await hubDb({
        connection: { url: name === "default" ? databaseUrl : "file:unused.sqlite" },
        ...(name === "orders" ? { driver: "d1", databaseId: "content-id", databaseName: "content-db" } as const : {}),
      })(undefined, {
        hook: (event: string, callback: (config: Record<string, unknown>) => Promise<void> | void) => {
          if (event === "nitro:config") hooks.push(callback)
        },
        options: { buildDir: join(root, ".nuxt"), dev: false, nitro: { preset: "node-server" }, rootDir: root, vite: {} },
      })
      const config = { alias: {} as Record<string, string>, exportConditions: ["node"] }
      for (const hook of hooks) await hook(config)
      expect(config.exportConditions).toEqual(["node"])
      const runtime = config.alias["@vite-hub/database/drizzle"]
      // Nuxt CLI clears buildDir after ready() and nitro:config, before compiling.
      await rm(join(root, ".nuxt"), { recursive: true, force: true })
      await expect(readFile(runtime!, "utf8")).resolves.toContain("export function useDatabase")

      const entry = join(root, "server.mjs")
      await writeFile(entry, [
        'import { useDatabase } from "@vite-hub/database/drizzle"',
        `const { db, schema } = useDatabase(${JSON.stringify(name)})`,
        'if (process.argv[2] === "seed") {',
        '  await db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")',
        '  await db.insert(schema.users).values({ id: 7, name: "Migrated user" })',
        "}",
        "console.log(JSON.stringify(await db.select().from(schema.users)))",
      ].join("\n"))
      const output = join(root, "server.output.mjs")
      await build({
        alias: { ...config.alias, "@vite-hub/database": join(packageRoot, "src/index.ts") },
        bundle: true,
        entryPoints: [entry],
        format: "esm",
        outfile: output,
        packages: "external",
        platform: "node",
        plugins: [{
          name: "node-file-imports",
          setup(plugin) {
            // Nitro accepts file URLs. Resolve source .js imports to .ts when testing the unpacked owner.
            plugin.onResolve({ filter: /^file:\/\// }, args => plugin.resolve(fileURLToPath(args.path), {
              kind: args.kind,
              resolveDir: args.resolveDir,
            }))
          },
        }],
      })
      for (const mode of ["seed", "read"]) {
        const { stdout } = await execFileAsync(process.execPath, [output, mode], { cwd: root })
        expect(JSON.parse(stdout)).toEqual([{ id: 7, name: "Migrated user" }])
      }
      expect((await readFile(join(root, "data", `${name}.sqlite`))).subarray(0, 15).toString()).toBe("SQLite format 3")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
