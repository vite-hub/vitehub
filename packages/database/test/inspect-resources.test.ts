import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { inspectDatabaseResources } from "../src/inspect.ts"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function writeDefinition(rootDir: string, name: string, cloudflare: string) {
  const dir = join(rootDir, "server", "databases", name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "index.ts"), [
    "import { defineDatabase } from '@vite-hub/database'",
    "export default defineDatabase({",
    `  name: ${JSON.stringify(name)},`,
    `  cloudflare: { ${cloudflare} },`,
    "  schema: {},",
    "})",
    "",
  ].join("\n"), "utf8")
}

describe("Database resource inspection", () => {
  it("shows where each D1 id comes from", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-resources-"))
    directories.push(rootDir)
    await writeDefinition(rootDir, "primary", "binding: 'PRIMARY', databaseName: 'primary-db', databaseId: 'literal-id'")
    await writeDefinition(rootDir, "analytics", "databaseName: 'analytics-db', databaseId: env({ source: env.source('ANALYTICS_D1_ID') })")
    await writeDefinition(rootDir, "cache", "databaseName: 'cache-db'")
    await writeDefinition(rootDir, "remote", "databaseName: 'remote-db', http: true")
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub", "provision.json"), JSON.stringify({ cloudflare: { d1: { analytics: "state-analytics", cache: "state-cache" } } }))

    const resources = inspectDatabaseResources({ env: { ANALYTICS_D1_ID: "env-id" }, options: undefined, provisionRoot: rootDir, rootDir })

    expect(Object.fromEntries(resources.map(({ definition, ...resource }) => [definition, resource]))).toEqual({
      analytics: { binding: "DB_ANALYTICS", env: "ANALYTICS_D1_ID", host: "cloudflare", id: "env-id", kind: "cloudflare-d1", name: "analytics-db", owner: "database", source: "env" },
      cache: { binding: "DB_CACHE", host: "cloudflare", id: "state-cache", kind: "cloudflare-d1", name: "cache-db", owner: "database", source: "provision-state" },
      primary: { binding: "PRIMARY", host: "cloudflare", id: "literal-id", kind: "cloudflare-d1", name: "primary-db", owner: "database", source: "config" },
    })
    expect(inspectDatabaseResources({ env: {}, options: undefined, provisionRoot: rootDir, rootDir }).find(resource => resource.definition === "analytics"))
      .toMatchObject({ id: "state-analytics", source: "provision-state" })
    expect(inspectDatabaseResources({ env: { ANALYTICS_D1_ID: " \t\n " }, options: undefined, provisionRoot: rootDir, rootDir }).find(resource => resource.definition === "analytics"))
      .toMatchObject({ id: "state-analytics", source: "provision-state" })
    expect(inspectDatabaseResources({ env: { ANALYTICS_D1_ID: " env-id \t" }, options: undefined, provisionRoot: rootDir, rootDir }).find(resource => resource.definition === "analytics"))
      .toMatchObject({ env: "ANALYTICS_D1_ID", id: "env-id", source: "env" })
  })
})
