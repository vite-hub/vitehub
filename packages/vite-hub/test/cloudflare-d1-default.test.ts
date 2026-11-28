import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { setResolvedFeatureOptions } from "@vite-hub/internal/build/vite"

import { vitehub } from "../src/index.ts"
import { runCli } from "./support/content-cms.ts"

import type { PluginOption } from "vite"

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-d1-default-"))
  roots.push(root)
  await Promise.all(Object.entries({
    "package.json": JSON.stringify({ name: "ocean-app", private: true, type: "module" }),
    "src/server.ts": "export default { fetch: () => new Response('ok') }\n",
    ...files,
  }).map(async ([file, content]) => {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), content)
  }))
  return root
}

async function plannedD1(root: string, plugins: PluginOption[]) {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    return Response.json({ result: new URL(url).pathname.endsWith("/r2/buckets") ? { buckets: [] } : [], success: true })
  })
  process.env.CLOUDFLARE_ACCOUNT_ID = "account"
  process.env.CLOUDFLARE_API_TOKEN = "token"
  try {
    const result = await runCli(root, plugins, ["provision", "run", "--host", "cloudflare", "--dry-run", "--json"])
    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    const plan = JSON.parse(result.stdout) as { actions?: Array<{ kind: string, name: string }> }
    return (plan.actions ?? []).filter(action => action.kind === "cloudflare-d1").map(action => action.name)
  }
  finally {
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    delete process.env.CLOUDFLARE_API_TOKEN
  }
}

const sqliteDefinition = "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ schema: {} })\n"

describe("Cloudflare Database without a D1 name", () => {
  it("provisions a D1 database named after the app", async () => {
    const root = await project({ "server/databases/default.ts": sqliteDefinition })
    expect(await plannedD1(root, vitehub({ host: "cloudflare", env: false, database: true }))).toEqual(["ocean-app-db"])
  }, 60_000)

  it("uses the vitehub name when it is set", async () => {
    const root = await project({ "server/databases/default.ts": sqliteDefinition })
    expect(await plannedD1(root, vitehub({ host: "cloudflare", env: false, name: "Shop", database: true }))).toEqual(["shop-db"])
  }, 60_000)

  it("names the D1 database of the Database Nuxt module options", async () => {
    const root = await project({ "server/databases/default.ts": sqliteDefinition })
    const nuxtDatabase = { name: "nuxt-database", config: (config: object) => setResolvedFeatureOptions(config, "database", { driver: "cloudflare", nuxtHostResource: true, projectRoot: root }) }
    expect(await plannedD1(root, [nuxtDatabase, ...vitehub({ host: "cloudflare", env: false, database: true })])).toEqual(["ocean-app-db"])
  }, 60_000)

  it("keeps the D1 database that the options or the Definition name", async () => {
    const root = await project({ "server/databases/default.ts": sqliteDefinition })
    expect(await plannedD1(root, vitehub({ host: "cloudflare", env: false, database: { driver: "cloudflare", databaseName: "shop-data" } }))).toEqual(["shop-data"])
    const named = await project({
      "server/databases/default.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ cloudflare: { databaseName: 'own-db' }, schema: {} })\n",
    })
    expect(await plannedD1(named, vitehub({ host: "cloudflare", env: false, database: true }))).toEqual(["own-db"])
  }, 60_000)

  it("adds no D1 database for a libSQL connection or Postgres Definitions", async () => {
    const libsql = await project({ "server/databases/default.ts": sqliteDefinition })
    expect(await plannedD1(libsql, vitehub({ host: "cloudflare", env: false, database: { connection: { url: "libsql://shop.turso.io" } } }))).toEqual([])
    const postgres = await project({
      "server/databases/default.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ dialect: 'postgresql', schema: {} })\n",
    })
    expect(await plannedD1(postgres, vitehub({ host: "cloudflare", env: false, database: {} }))).toEqual([])
  }, 60_000)
})
