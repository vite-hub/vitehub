import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { libsqlStartupRule } from "../src/internal/bundle-startup.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function project(definitions: Record<string, string> = {}, extension = "ts") {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-bundle-"))
  tempDirs.push(rootDir)
  for (const [name, body] of Object.entries(definitions)) {
    const file = join(rootDir, "server", "databases", `${name}.${extension}`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, [
      "import { defineDatabase } from '@vite-hub/database'",
      "import { sqliteTable, text } from 'drizzle-orm/sqlite-core'",
      "const items = sqliteTable('items', { title: text('title') })",
      ...body.startsWith("export") ? [body] : [`export default defineDatabase({ name: ${JSON.stringify(name)}, schema: { items }, ${body} })`],
      "",
    ].join("\n"))
  }
  return rootDir
}

describe("libSQL startup rule", () => {
  it("declares libSQL as not needed at startup on a Cloudflare build where every Database is D1", async () => {
    const rootDir = await project()
    const config = resolveDBViteConfig({ driver: "d1" }, rootDir, { implicitDefault: true })
    expect(libsqlStartupRule(config, "cloudflare-module")).toMatchObject({
      owner: "@vite-hub/database",
      packages: expect.arrayContaining(["@libsql/client", "@libsql/hrana-client"]),
    })
  })

  it("declares nothing on a host where libSQL serves the Database", async () => {
    const rootDir = await project()
    expect(libsqlStartupRule(resolveDBViteConfig(undefined, rootDir, { implicitDefault: true }), "node-server")).toBeUndefined()
  })

  it.each([
    ["a remote libSQL URL", "connection: { url: 'libsql://app.turso.io' }"],
    ["a URL from the environment", "connection: { url: process.env.DATABASE_URL }"],
    ["a connection that the build cannot read", "connection: makeConnection()"],
    ["a spread that can hold a connection", "...shared"],
  ])("declares nothing when a Definition has %s", async (_label, body) => {
    const rootDir = await project({ default: `cloudflare: { databaseId: 'id' }, ${body}` })
    const config = resolveDBViteConfig({ driver: "d1" }, rootDir, { implicitDefault: true })
    expect(libsqlStartupRule(config, "cloudflare-module")).toBeUndefined()
  })

  it("keeps the rule when a Definition sets only a local file URL", async () => {
    const rootDir = await project({ default: "cloudflare: { databaseId: 'id' }, connection: { url: 'file:.data/app.db' }" })
    const config = resolveDBViteConfig({ driver: "d1" }, rootDir, { implicitDefault: true })
    expect(libsqlStartupRule(config, "cloudflare-module")).toBeDefined()
  })

  it.each([
    ["connection", "connection: { url: 'file:.data/app.db' }, connection: { url: 'libsql://app.turso.io' }"],
    ["url", "connection: { url: 'file:.data/app.db', url: 'libsql://app.turso.io' }"],
  ])("declares nothing when a JavaScript Definition repeats %s", async (_label, body) => {
    const rootDir = await project({ default: `cloudflare: { databaseId: 'id' }, ${body}` }, "js")
    const config = resolveDBViteConfig({ driver: "d1" }, rootDir, { implicitDefault: true })
    expect(libsqlStartupRule(config, "cloudflare-module")).toBeUndefined()
  })
})
