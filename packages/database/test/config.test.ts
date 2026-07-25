import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { discoverDatabaseDefinitions, resolveDBViteConfig } from "../src/config.ts"

const tempDirs: string[] = []

async function createTempProject() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-config-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeDefinition(rootDir: string, path: string, tables = "notes", options: { cloudflare?: string, connection?: string } = {}) {
  const file = join(rootDir, path)
  const name = /(?:^|\/)src\/([^/]+)\.database\./.exec(path)?.[1]
    ?? /(?:^|\/)server\/databases\/([^/]+)\/config\./.exec(path)?.[1]
    ?? "default"
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    `const ${tables} = sqliteTable('${tables}', { title: text('title') })`,
    "export default defineDatabase({",
    `  name: ${JSON.stringify(name)},`,
    ...(options.cloudflare ? ["  cloudflare: {", options.cloudflare, "  },"] : []),
    ...(options.connection ? ["  connection: {", options.connection, "  },"] : []),
    `  schema: { ${tables} },`,
    "})",
    "",
  ].join("\n"))
  return file
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("discoverDatabaseDefinitions", () => {
  it("discovers the server default database definition", async () => {
    const rootDir = await createTempProject()
    const file = await writeDefinition(rootDir, "server/databases/config.ts")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([{
      handler: file,
      mode: "default",
      name: "default",
      source: "server-database-default",
      tableNames: ["notes"],
    }])
  })

  it("discovers named server database definitions", async () => {
    const rootDir = await createTempProject()
    const analytics = await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")
    const tenant = await writeDefinition(rootDir, "server/databases/tenant/config.ts", "accounts")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: analytics, mode: "named", name: "analytics", tableNames: ["events"] }),
      expect.objectContaining({ handler: tenant, mode: "named", name: "tenant", tableNames: ["accounts"] }),
    ])
  })

  it("rejects a definition name that does not match its discovered identity", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/analytics/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "export default defineDatabase({ name: 'default', schema: {} })",
      "",
    ].join("\n"))

    expect(() => discoverDatabaseDefinitions(rootDir)).toThrow('must set `name: "analytics"`')
  })

  it("discovers Vite default and suffix database definitions", async () => {
    const rootDir = await createTempProject()
    const analytics = await writeDefinition(rootDir, "src/analytics.database.ts", "events")

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: analytics, mode: "named", name: "analytics", source: "vite-database-suffix" }),
    ])
  })

  it("reads table names from the exported database definition only", async () => {
    const rootDir = await createTempProject()
    const file = join(rootDir, "server/databases/config.ts")
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const ignored = sqliteTable('ignored', { title: text('title') })",
      "const notes = sqliteTable('notes', { title: text('title') })",
      "const decoy = { schema: { ignored } }",
      "defineDatabase(decoy)",
      "export default defineDatabase({",
      "  schema: { notes },",
      "})",
      "",
    ].join("\n"))

    expect(discoverDatabaseDefinitions(rootDir)).toEqual([
      expect.objectContaining({ handler: file, tableNames: ["notes"] }),
    ])
  })

  it("rejects mixing the default database with named databases", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")

    expect(() => discoverDatabaseDefinitions(rootDir)).toThrow("either one default database or all named databases")
  })
})

describe("resolveDBViteConfig", () => {
  it("returns undefined when no database definition exists", async () => {
    const rootDir = await createTempProject()

    expect(resolveDBViteConfig(undefined, rootDir)).toBeUndefined()
  })

  it("resolves generated files, migrations, and local fallback connection", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")

    const resolved = resolveDBViteConfig(undefined, rootDir)

    expect(resolved?.databaseNames).toEqual(["default"])
    expect(resolved?.databases.default).toMatchObject({
      connection: { url: "file:.vitehub/data/database/sqlite.db" },
      dialect: "sqlite",
      migrationsDir: "server/databases/migrations",
      mode: "default",
      name: "default",
      orm: "drizzle",
    })
    expect(resolved?.generatedDrizzleConfigFilesByDatabase.default).toBe(join(rootDir, ".vitehub/database/drizzle/default.config.ts"))
    expect(resolved?.generatedSchemaFilesByDatabase.default).toBe(join(rootDir, ".vitehub/database/schema/default.ts"))
    expect(resolved?.generatedDrizzleConfigFile).toBe(join(rootDir, ".vitehub/database/drizzle.config.ts"))
  })

  it("resolves named database defaults from definition locations", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/analytics/config.ts", "events")

    const resolved = resolveDBViteConfig(undefined, rootDir)

    expect(resolved?.databases.analytics).toMatchObject({
      connection: { url: "file:.vitehub/data/database/analytics.sqlite.db" },
      migrationsDir: "server/databases/analytics/migrations",
      mode: "named",
    })
  })

  it("uses the integration connection when the definition does not select a host", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts")
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    const originalUrl = process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.TURSO_DATABASE_URL

    const connection = {
      authToken: {
        kind: "env-variable" as const,
        source: { kind: "env" as const, name: "TURSO_AUTH_TOKEN" },
      },
      url: {
        kind: "env-variable" as const,
        source: { kind: "env" as const, name: "TURSO_DATABASE_URL" },
      },
    }

    try {
      expect(resolveDBViteConfig({ connection }, rootDir)?.databases.default.connection).toEqual(connection)
    }
    finally {
      if (typeof originalAuthToken === "undefined") delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
      if (typeof originalUrl === "undefined") delete process.env.TURSO_DATABASE_URL
      else process.env.TURSO_DATABASE_URL = originalUrl
    }
  })

  it("lets a definition override the integration connection URL", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      connection: "    url: 'libsql://definition.example.turso.io',",
    })

    expect(resolveDBViteConfig({
      connection: {
        authToken: "integration-token",
        url: "libsql://integration.example.turso.io",
      },
    }, rootDir)?.databases.default.connection).toEqual({
      authToken: "integration-token",
      url: "libsql://definition.example.turso.io",
    })
  })

  it("preserves an unresolved definition URL over the integration connection", async () => {
    const rootDir = await createTempProject()
    const originalUrl = process.env.ANALYTICS_DATABASE_URL
    delete process.env.ANALYTICS_DATABASE_URL

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: "    url: process.env.ANALYTICS_DATABASE_URL,",
      })

      expect(resolveDBViteConfig({
        connection: {
          authToken: "integration-token",
          url: "libsql://integration.example.turso.io",
        },
      }, rootDir)?.databases.default.connection).toEqual({
        authToken: "integration-token",
        url: {
          kind: "env-variable",
          source: { kind: "env", name: "ANALYTICS_DATABASE_URL" },
        },
      })
    }
    finally {
      if (typeof originalUrl === "undefined") delete process.env.ANALYTICS_DATABASE_URL
      else process.env.ANALYTICS_DATABASE_URL = originalUrl
    }
  })

  it("preserves an unresolved definition auth token for a remote URL", async () => {
    const rootDir = await createTempProject()
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    delete process.env.TURSO_AUTH_TOKEN

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: [
          "    authToken: process.env.TURSO_AUTH_TOKEN,",
          "    url: 'libsql://definition.example.turso.io',",
        ].join("\n"),
      })

      expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.connection).toEqual({
        authToken: {
          kind: "env-variable",
          source: { kind: "env", name: "TURSO_AUTH_TOKEN" },
        },
        url: "libsql://definition.example.turso.io",
      })
    }
    finally {
      if (typeof originalAuthToken === "undefined") delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
    }
  })

  it("uses the local connection fallback when an env-only URL is unset", async () => {
    const rootDir = await createTempProject()
    const originalAuthToken = process.env.TURSO_AUTH_TOKEN
    const originalUrl = process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.TURSO_DATABASE_URL

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        connection: [
          "    authToken: process.env.TURSO_AUTH_TOKEN,",
          "    url: process.env.TURSO_DATABASE_URL,",
        ].join("\n"),
      })

      expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.connection).toEqual({
        authToken: undefined,
        url: "file:.vitehub/data/database/sqlite.db",
      })
    }
    finally {
      if (typeof originalAuthToken === "undefined") delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = originalAuthToken
      if (typeof originalUrl === "undefined") delete process.env.TURSO_DATABASE_URL
      else process.env.TURSO_DATABASE_URL = originalUrl
    }
  })

  it("preserves explicit D1 HTTP proxy declarations without resolving their secrets", async () => {
    const rootDir = await createTempProject()
    const originalToken = process.env.D1_HTTP_TOKEN
    const originalUrl = process.env.D1_HTTP_URL
    delete process.env.D1_HTTP_TOKEN
    delete process.env.D1_HTTP_URL

    try {
      await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
        cloudflare: [
          "    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,",
          "    http: {",
          "      authToken: process.env.D1_HTTP_TOKEN,",
          "      url: process.env.D1_HTTP_URL,",
          "    },",
        ].join("\n"),
      })

      expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.cloudflare).toMatchObject({
        http: {
          authToken: {
            kind: "env-variable",
            source: { kind: "env", name: "D1_HTTP_TOKEN" },
          },
          url: {
            kind: "env-variable",
            source: { kind: "env", name: "D1_HTTP_URL" },
          },
        },
      })
    }
    finally {
      if (typeof originalToken === "undefined") delete process.env.D1_HTTP_TOKEN
      else process.env.D1_HTTP_TOKEN = originalToken
      if (typeof originalUrl === "undefined") delete process.env.D1_HTTP_URL
      else process.env.D1_HTTP_URL = originalUrl
    }
  })

  it("preserves Runtime Env declarations for D1 HTTP proxy config", async () => {
    const rootDir = await createTempProject()
    await writeDefinition(rootDir, "server/databases/config.ts", "notes", {
      cloudflare: [
        "    databaseId: env({ source: env.source('CLOUDFLARE_D1_DATABASE_ID') }),",
        "    http: {",
        "      authToken: env({ secret: true, source: env.source('D1_HTTP_TOKEN') }),",
        "      url: env({ source: env.source(['D1_HTTP_URL', 'D1_PROXY_URL']) }),",
        "    },",
      ].join("\n"),
    })

    expect(resolveDBViteConfig(undefined, rootDir)?.databases.default.cloudflare).toMatchObject({
      databaseId: {
        kind: "env-variable",
        source: { kind: "env", name: "CLOUDFLARE_D1_DATABASE_ID" },
      },
      http: {
        authToken: {
          kind: "env-variable",
          source: { kind: "env", name: "D1_HTTP_TOKEN" },
        },
        url: {
          kind: "env-variable",
          source: { kind: "env", name: "D1_HTTP_URL", names: ["D1_HTTP_URL", "D1_PROXY_URL"] },
        },
      },
    })
  })
})
