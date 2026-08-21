import { createServer as createHttpServer, type Server } from "node:http"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"
import { createServer as createViteServer } from "vite"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import {
  DB_VIRTUAL_DATABASES_ID,
  DB_VIRTUAL_SCHEMA_ID,
  hubDb,
} from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-vite-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDefinition(rootDir: string, path: string, table = "notes", options: { cloudflare?: string, connection?: string } = {}) {
  const file = join(rootDir, path)
  const name = /(?:^|\/)src\/([^/]+)\.database\./.exec(path)?.[1]
    ?? /(?:^|\/)server\/databases\/([^/]+)\/config\./.exec(path)?.[1]
    ?? "default"
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${table} = sqliteTable('${table}', { title: text('title') })`,
    "export default defineDatabase({",
    `  name: ${JSON.stringify(name)},`,
    ...(options.cloudflare ? ["  cloudflare: {", options.cloudflare, "  },"] : []),
    ...(options.connection ? ["  connection: {", options.connection, "  },"] : []),
    `  schema: { ${table} },`,
    "})",
    "",
  ].join("\n"))
  return file
}

async function resolveCliContributor(plugin: ReturnType<typeof hubDb>) {
  const cli = plugin.vitehub?.cli
  return typeof cli === "function" ? await cli() : cli
}

async function listenHttpServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.")
  return `http://127.0.0.1:${address.port}`
}

async function closeHttpServer(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubDb", () => {
  it("routes Vite development queries through configured Cloudflare D1 HTTP", async () => {
    const rootDir = await createTempProject()
    await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    let proxyRequest: { authorization?: string, body?: unknown, method?: string, path?: string } = {}
    const proxy = createHttpServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      proxyRequest = {
        authorization: request.headers.authorization,
        body: JSON.parse(body),
        method: request.method,
        path: request.url,
      }
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({
        result: [{ results: { rows: [["remote note"]] }, success: true }],
        success: true,
      }))
    })
    const proxyUrl = await listenHttpServer(proxy)

    await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      cloudflare: [
        "    databaseId: 'dev-database-id',",
        "    http: {",
        "      authToken: 'dev-proxy-token',",
        `      url: ${JSON.stringify(`${proxyUrl}/raw`)},`,
        "    },",
      ].join("\n"),
    })
    await mkdir(join(rootDir, "server"), { recursive: true })
    await writeFile(join(rootDir, "server", "query.ts"), [
      "import { db, schema } from '@vite-hub/database/drizzle'",
      "export const query = () => db.select().from(schema.notes)",
      "",
    ].join("\n"))
    await writeFile(join(rootDir, "index.html"), "<div>ViteHub Database</div>")

    const server = await createViteServer({
      configFile: false,
      plugins: [hubDb()],
      root: rootDir,
      server: { host: "127.0.0.1", port: 0 },
    })

    try {
      await server.listen()
      const module = await server.ssrLoadModule(join(rootDir, "server", "query.ts")) as {
        query: () => Promise<Array<{ title: string }>>
      }

      await expect(module.query()).resolves.toEqual([{ title: "remote note" }])
      expect(proxyRequest).toMatchObject({
        authorization: "Bearer dev-proxy-token",
        body: { params: [], sql: expect.stringContaining("notes") },
        method: "POST",
        path: "/raw",
      })
    }
    finally {
      await Promise.all([server.close(), closeHttpServer(proxy)])
    }
  }, 30_000)

  it("exposes integration connection defaults to direct definitions", async () => {
    const plugin = hubDb({
      connection: {
        authToken: "token",
        url: "libsql://database.example.turso.io",
      },
    })
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ database: undefined, root: await createTempProject() } as never)

    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>
    const id = await resolveId("#vitehub/database/definition-defaults")

    expect(await load(id!)).toContain("libsql://database.example.turso.io")
  })

  it("resolves discovered database definitions and writes generated artifacts", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ db: undefined, root: rootDir } as never)

    expect(plugin.api.getConfig()).toMatchObject({
      databaseNames: ["default"],
      databases: {
        default: {
          connection: { url: "file:.vitehub/data/database/sqlite.db" },
          migrationsDir: "server/databases/migrations",
          mode: "default",
        },
      },
    })
    await expect(readFile(join(rootDir, ".vitehub/database/schema/default.ts"), "utf8")).resolves.toContain("export const notes")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")).resolves.toContain("server/databases/migrations")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")).resolves.toContain("dbCredentials")
    await expect(readFile(join(rootDir, ".vitehub/database/drizzle/default.config.ts"), "utf8")).resolves.toContain("file:.vitehub/data/database/sqlite.db")
  })

  it("resolves discovery and generated artifacts from projectRoot", async () => {
    const rootDir = await createTempProject()
    const projectRoot = join(rootDir, "packages", "db")
    await writeDefinition(projectRoot, "server/databases/config.ts")

    const plugin = hubDb({ projectRoot: "packages/db" })
    const configure = plugin.config as (config: unknown, env: unknown) => void
    configure({ [VITEHUB_SERVER_DIRS]: [join(rootDir, "server")] }, { command: "serve", mode: "test" })
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ database: undefined, root: rootDir } as never)

    expect(plugin.api.getConfig()?.rootDir).toBe(projectRoot)
    await expect(readFile(join(projectRoot, ".vitehub/database/schema/default.ts"), "utf8"))
      .resolves.toContain("export const notes")
  })

  it("writes one Drizzle config per named database migrations directory", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")
    await writeDefinition(rootDir, "server/databases/primary/config.ts", "notes")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ db: undefined, root: rootDir } as never)

    const analyticsConfig = await readFile(join(rootDir, ".vitehub/database/drizzle/analytics.config.ts"), "utf8")
    const primaryConfig = await readFile(join(rootDir, ".vitehub/database/drizzle/primary.config.ts"), "utf8")

    expect(analyticsConfig).toContain("server/databases/analytics/migrations")
    expect(analyticsConfig).toContain("file:.vitehub/data/database/analytics.sqlite.db")
    expect(primaryConfig).toContain("server/databases/primary/migrations")
    expect(primaryConfig).toContain("file:.vitehub/data/database/primary.sqlite.db")
  })

  it("keeps env-sourced Drizzle credentials as runtime expressions", async () => {
    const rootDir = await createTempProject()
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    const originalUrl = process.env.TURSO_DATABASE_URL
    process.env.TURSO_AUTH_TOKEN = "secret-token"
    process.env.TURSO_DATABASE_URL = "libsql://secret.example.turso.io"

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: [
          "    authToken: process.env.TURSO_AUTH_TOKEN,",
          "    url: process.env.TURSO_DATABASE_URL,",
        ].join("\n"),
      })

      const plugin = hubDb()
      const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
      await configResolved({ db: undefined, root: rootDir } as never)

      const drizzleConfig = await readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")
      expect(drizzleConfig).toContain("authToken: process.env[\"TURSO_AUTH_TOKEN\"]")
      expect(drizzleConfig).toContain("url: process.env[\"TURSO_DATABASE_URL\"]")
      expect(drizzleConfig).not.toContain("secret-token")
      expect(drizzleConfig).not.toContain("secret.example")
    }
    finally {
      if (typeof originalAuthToken === "undefined") delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
      if (typeof originalUrl === "undefined") delete process.env.TURSO_DATABASE_URL
      else process.env.TURSO_DATABASE_URL = originalUrl
    }
  })

  it("writes Cloudflare D1 HTTP credentials for Drizzle Kit", async () => {
    const rootDir = await createTempProject()
    const originalDatabaseId = process.env.CLOUDFLARE_D1_DATABASE_ID
    process.env.CLOUDFLARE_D1_DATABASE_ID = "secret-database-id"

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        cloudflare: [
          "    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,",
          "    http: true,",
        ].join("\n"),
      })

      const plugin = hubDb()
      const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
      await configResolved({ db: undefined, root: rootDir } as never)

      const drizzleConfig = await readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")
      expect(drizzleConfig).toContain("driver: \"d1-http\"")
      expect(drizzleConfig).toContain("accountId: process.env[\"CLOUDFLARE_ACCOUNT_ID\"]")
      expect(drizzleConfig).toContain("databaseId: process.env[\"CLOUDFLARE_D1_DATABASE_ID\"]")
      expect(drizzleConfig).toContain("token: process.env[\"CLOUDFLARE_API_TOKEN\"]")
      expect(drizzleConfig).not.toContain("secret-database-id")
    }
    finally {
      if (typeof originalDatabaseId === "undefined") delete process.env.CLOUDFLARE_D1_DATABASE_ID
      else process.env.CLOUDFLARE_D1_DATABASE_ID = originalDatabaseId
    }
  })

  it("keeps Drizzle Kit on libSQL when D1 HTTP is not selected", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      cloudflare: "    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,",
      connection: [
        "    authToken: 'libsql-token',",
        "    url: 'libsql://database.example.turso.io',",
      ].join("\n"),
    })

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ db: undefined, root: rootDir } as never)

    const drizzleConfig = await readFile(join(rootDir, ".vitehub/database/drizzle.config.ts"), "utf8")
    expect(drizzleConfig).toContain("url: \"libsql://database.example.turso.io\"")
    expect(drizzleConfig).toContain("authToken: \"libsql-token\"")
    expect(drizzleConfig).not.toContain("driver: \"d1-http\"")
  })

  it("lets top-level config disable the database plugin", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ database: false, root: rootDir } as never)

    expect(plugin.api.getConfig()).toBeUndefined()
  })

  it("does not contribute the DB CLI namespace when top-level config disables the database plugin", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ database: false, root: rootDir } as never)

    await expect(resolveCliContributor(plugin)).resolves.toBeUndefined()
  })

  it("contributes provisioning but no CLI namespaces when resolved config disables database CLI", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ database: { cli: false }, root: rootDir } as never)

    const contributor = await resolveCliContributor(plugin)
    expect(contributor?.namespaces).toEqual([])
    expect(contributor?.provision?.map(step => step.id)).toEqual(["database:cloudflare-d1"])
  })

  it("exposes default schema and database registry through stable ViteHub import paths", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ root: rootDir } as never)

    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>

    const resolvedSchemaId = await resolveId(DB_VIRTUAL_SCHEMA_ID)
    const resolvedDatabasesId = await resolveId(DB_VIRTUAL_DATABASES_ID)
    const schemaCode = await load(resolvedSchemaId!)
    const databasesCode = await load(resolvedDatabasesId!)

    expect(schemaCode).toContain("export { default, schema }")
    expect(schemaCode).toContain(join(rootDir, ".vitehub/database/schema/default.ts"))
    expect(databasesCode).toContain(definition)
    expect(databasesCode).toContain("\"default\"")
    expect(databasesCode).toContain("\"server/databases/migrations\"")
    const generatedTypesFile = join(rootDir, ".vitehub/types/database.d.ts")
    const generatedTypes = await readFile(generatedTypesFile, "utf8")
    expect(generatedTypes).toContain('declare module "@vite-hub/database/drizzle"')
    expect(generatedTypes).toContain('declare module "vite-hub/database/drizzle"')
    expect(generatedTypes).toContain("type DefaultDatabaseSchema = typeof database_0.schema")
    expect(generatedTypes).toContain('declare module "#vitehub/database/schema" {\n  interface DatabaseSchema extends DefaultDatabaseSchema {}')

    await configResolved({ database: false, root: rootDir } as never)
    await expect(readFile(generatedTypesFile, "utf8")).resolves.toBe("export {}\n")
  })

  it("refreshes generated artifacts during definition hot updates", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const invalidated: string[] = []
    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ root: rootDir } as never)

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>

    await writeFile(definition, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const tasks = sqliteTable('tasks', { title: text('title') })",
      "export default defineDatabase({ schema: { tasks } })",
      "",
    ].join("\n"))
    await handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if (id === `\0${DB_VIRTUAL_SCHEMA_ID}` || id === `\0${DB_VIRTUAL_DATABASES_ID}`) {
              return { id }
            }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual([`\0${DB_VIRTUAL_SCHEMA_ID}`, `\0${DB_VIRTUAL_DATABASES_ID}`])
    await expect(readFile(join(rootDir, ".vitehub/database/schema/default.ts"), "utf8")).resolves.toContain("export const tasks")
  })

  it("normalizes definition paths before matching hot updates", async () => {
    const rootDir = await createTempProject()
    const definition = await writeDefinition(rootDir, "server/databases/config.ts")

    const invalidated: string[] = []
    const plugin = hubDb()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({ root: rootDir } as never)

    const config = plugin.api.getConfig()!
    config.definitions[0]!.handler = config.definitions[0]!.handler.replaceAll("/", "\\")

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => Promise<void>

    await handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if (id === `\0${DB_VIRTUAL_SCHEMA_ID}` || id === `\0${DB_VIRTUAL_DATABASES_ID}`) {
              return { id }
            }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual([`\0${DB_VIRTUAL_SCHEMA_ID}`, `\0${DB_VIRTUAL_DATABASES_ID}`])
  })
})
