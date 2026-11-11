import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { build } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import { usesRemoteLibsql } from "../src/internal/vite-build.ts"
import { hubDb } from "../src/vite.ts"

const packageRoot = resolve(import.meta.dirname, "..")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

const d1 = "cloudflare: { databaseId: 'database-id', databaseName: 'app' },"

async function createProject(definition: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-db-libsql-build-"))
  tempDirs.push(root)
  const file = join(root, "server/databases/default.ts")
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineDatabase } from '@vite-hub/database'",
    "const options = { schema: {} }",
    definition,
    "",
  ].join("\n"))
  return root
}

/** Runs the Vite plugin as a Vite build or dev server for `preset`, and returns how it resolves `#vitehub/database/libsql`. */
async function resolveLibsql(root: string, preset: string, command: "build" | "serve" = "build") {
  const plugin = hubDb()
  // SAFETY: hubDb exposes configResolved and resolveId.handler as callable Vite hooks.
  await (plugin.configResolved as (config: unknown) => Promise<void>)({ build: { outDir: "dist" }, command, nitro: { preset }, plugins: [{ name: "nitro:main" }], root })
  const resolveId = (plugin.resolveId as { handler: (id: string) => string | undefined }).handler
  return { config: plugin.api.getConfig(), id: resolveId("#vitehub/database/libsql") }
}

/** Every package that the Worker bundle of `@vite-hub/database` contains, through static and dynamic imports. */
async function bundledPackages(libsqlModule: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-db-libsql-bundle-"))
  tempDirs.push(dir)
  const stub = join(dir, "stub.mjs")
  await writeFile(stub, "export default {}\n", "utf8")
  const { metafile } = await build({
    alias: {
      "#vitehub/database/databases": stub,
      "#vitehub/database/definition-defaults": stub,
      "#vitehub/database/libsql": libsqlModule ?? join(packageRoot, "src/runtime/libsql.ts"),
      "#vitehub/database/schema": stub,
    },
    bundle: true,
    conditions: ["workerd", "worker", "browser"],
    entryPoints: [join(packageRoot, "src/index.ts"), join(packageRoot, "src/runtime/definition-local.ts")],
    external: ["cloudflare:workers", "node:*"],
    format: "esm",
    metafile: true,
    outdir: join(dir, "out"),
    platform: "neutral",
    splitting: true,
    write: false,
  })
  return new Set(Object.keys(metafile.inputs).flatMap(input => /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1] ?? []))
}

describe("libSQL in a Cloudflare build", () => {
  it("leaves libSQL and SQLite WASM out of a Worker whose Databases are D1", async () => {
    const root = await createProject(`export default defineDatabase({ ${d1} schema: {} })`)
    const { config, id } = await resolveLibsql(root, "cloudflare-module")

    expect(usesRemoteLibsql(config!)).toBe(false)
    expect(id).toMatch(/runtime\/libsql-disabled\.(?:js|ts)$/)
    const packages = await bundledPackages(id)
    expect(packages).toContain("drizzle-orm")
    expect([...packages].filter(name => name.startsWith("@libsql/") || name === "@sqlite.org/sqlite-wasm")).toEqual([])
  }, 60_000)

  it.each([
    ["a remote libSQL URL", `export default defineDatabase({ ${d1} connection: { url: 'libsql://app.example' }, schema: {} })`],
    ["a WebSocket libSQL URL", `export default defineDatabase({ ${d1} connection: { url: 'wss://app.example' }, schema: {} })`],
    ["an environment URL", `export default defineDatabase({ ${d1} connection: { url: process.env.APP_DATABASE_URL }, schema: {} })`],
    ["a URL that the build cannot read", `export default defineDatabase({ ${d1} connection: { url: String(1) }, schema: {} })`],
    ["a Definition that the build cannot read", "export default defineDatabase(options)"],
  ])("keeps libSQL for %s", async (_case, definition) => {
    const root = await createProject(definition)
    const { config, id } = await resolveLibsql(root, "cloudflare-module")

    expect(usesRemoteLibsql(config!)).toBe(true)
    expect(id).toBeUndefined()
  })

  it.each([
    ["a Node build", "node-server", "build"],
    ["a Vercel build", "vercel", "build"],
    ["Cloudflare development", "cloudflare-module", "serve"],
  ] as const)("keeps local SQLite in %s", async (_case, preset, command) => {
    const root = await createProject(`export default defineDatabase({ ${d1} schema: {} })`)

    expect((await resolveLibsql(root, preset, command)).id).toBeUndefined()
  })

  it("bundles libSQL when the build keeps it", async () => {
    const packages = await bundledPackages(undefined)
    expect(packages).toContain("@libsql/client")
  }, 60_000)
})
