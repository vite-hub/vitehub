import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { glob } from "tinyglobby"
import { afterAll, describe, expect, it } from "vitest"

import { formatReport, runCodemod, runMigration } from "../src/index.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtures = join(packageRoot, "test/fixtures")
const scratch = join(packageRoot, ".tmp/nuxthub-test")

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function app(name: string, files: Record<string, string>): Promise<string> {
  const directory = join(scratch, name)
  await rm(directory, { recursive: true, force: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true })
    await writeFile(join(directory, path), content)
  }
  return directory
}

describe.each([
  ["nuxthub-starter", "nuxt-hub/starter: database, KV, Blob, and cache with a Wrangler config"],
  ["nuxthub-chat", "nuxt-ui-templates/chat: database relations, hub:db:schema type imports, and Blob"],
  ["nuxthub-atinotes", "atinux/atinotes: KV on Cloudflare and a legacy hubBlob() call"],
])("nuxthub with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const output = join(fixtures, name, "output")
    const run = await runCodemod("nuxthub", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      if (edit.after !== null) await expect(edit.after).toMatchFileSnapshot(join(output, edit.path))
    }
    // The output folder holds exactly the written files and the report.
    const written = run.result.edits.filter(edit => edit.after !== null).map(edit => edit.path)
    expect((await glob(["**/*"], { cwd: output, dot: true })).filter(file => file !== "report.txt").sort()).toEqual(written.sort())
    await expect(formatReport(run)).toMatchFileSnapshot(join(output, "report.txt"))
  })
})

describe("nuxthub", () => {
  it("runs through the migration and deletes the moved schema", async () => {
    const directory = join(scratch, "wizard")
    await rm(directory, { recursive: true, force: true })
    await cp(join(fixtures, "nuxthub-starter/input"), directory, { recursive: true })
    const migration = await runMigration({ cwd: directory })
    expect(migration.steps.map(step => [step.codemod.name, step.detection.reason, step.error])).toEqual([
      ["nuxthub", "nuxt.config.ts lists @nuxthub/core in modules", undefined],
    ])
    const files = await glob(["server/db/**", "server/databases/**"], { cwd: directory })
    expect(files.sort()).toEqual(["server/databases/config.ts", "server/databases/schema.ts"])
  })

  it("rewrites only the simple statement forms of KV and Blob calls", async () => {
    const directory = await app("calls", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { kv: true, blob: true } })\n",
      "server/api/demo.ts": [
        "import { kv as store } from '@nuxthub/kv'",
        "",
        "export default defineEventHandler(async () => {",
        "  const error = 1",
        "  const value = await store.get<string>('a');",
        "  let count = await store.get('count');",
        "  await store.set('a', value);",
        "  await blob.delete('x');",
        "  if (count) await store.del('a');",
        "  store.set('b', 1);",
        "  const keys = (await store.keys()).length;",
        "  await store.getItem('c');",
        "  return blob.serve(event, 'x');",
        "})",
        "",
      ].join("\n"),
      "server/api/shadow.ts": "export default defineEventHandler(async () => {\n  const kv = new Map()\n  return kv.get('a')\n})\n",
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    expect(run.result.edits.find(edit => edit.path === "server/api/demo.ts")?.after).toBe([
      "import { kv as store } from 'vite-hub/kv'",
      "",
      "export default defineEventHandler(async () => {",
      "  const error = 1",
      "  const [kvError, value] = await store.get<string>('a');",
      "  if (kvError) throw kvError;",
      "  const [error2, result] = await store.get('count');",
      "  if (error2) throw error2;",
      "  let count = result;",
      "  const [error3] = await store.set('a', value);",
      "  if (error3) throw error3;",
      "  const [blobError] = await blob.del('x');",
      "  if (blobError) throw blobError;",
      "  if (count) await store.del('a');",
      "  store.set('b', 1);",
      "  const keys = (await store.keys()).length;",
      "  await store.getItem('c');",
      "  return blob.serve(event, 'x');",
      "})",
      "",
    ].join("\n"))
    expect(run.result.edits.some(edit => edit.path === "server/api/shadow.ts")).toBe(false)
    expect(run.result.followUps.filter(followUp => followUp.file === "server/api/demo.ts").map(followUp => [followUp.line, followUp.message.slice(0, 40)])).toMatchInlineSnapshot(`
      [
        [
          9,
          "store.del() is used inside an expression",
        ],
        [
          10,
          "store.set() is not awaited. In ViteHub a",
        ],
        [
          11,
          "store.keys() is used inside an expressio",
        ],
        [
          12,
          "ViteHub KV has no getItem method. Rewrit",
        ],
        [
          13,
          "blob.serve() returns its result to the c",
        ],
      ]
    `)
  })

  it("stops for MySQL and leaves the app unchanged", async () => {
    const directory = await app("mysql", { "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['@nuxthub/core'], hub: { db: 'mysql' } })\n" })
    await expect(runCodemod("nuxthub", { cwd: directory, dryRun: true })).rejects.toThrow("ViteHub does not support MySQL")
  })

  it("maps driver options to follow-ups and merges into an existing vitehub key", async () => {
    const directory = await app("options", {
      "nuxt.config.ts": [
        "export default defineNuxtConfig({",
        "  modules: ['@nuxthub/core', 'vite-hub/nuxt'],",
        "  hub: {",
        "    db: { dialect: 'postgresql', driver: 'postgres-js' },",
        "    kv: { driver: 'upstash' },",
        "    dir: '.hub',",
        "  },",
        "  vitehub: {",
        "    preset: 'vercel',",
        "  },",
        "})",
        "",
      ].join("\n"),
      "server/db/schema/users.ts": "import { pgTable, text } from 'drizzle-orm/pg-core'\nimport { slug } from '../../utils/slug'\n\nexport const users = pgTable('users', { id: text('id') })\n",
      "server/utils/slug.ts": "export const slug = 1\n",
      "server/utils/db.ts": "import { users } from '~~/server/db/schema'\nimport type { User } from '../db/schema/users'\n\nexport { users }\n",
      "package.json": `${JSON.stringify({ dependencies: { "@nuxthub/core": "^0.10.0", "drizzle-orm": "^0.44.0" } }, null, 2)}\n`,
    })
    const run = await runCodemod("nuxthub", { cwd: directory, dryRun: true })
    const after = (path: string) => run.result.edits.find(edit => edit.path === path)?.after
    expect(after("nuxt.config.ts")).toMatchInlineSnapshot(`
      "export default defineNuxtConfig({
        modules: ['vite-hub/nuxt'],
        vitehub: {
          preset: 'vercel',
          database: true,
          kv: true,
        },
      })
      "
    `)
    expect(after("server/databases/schema/users.ts")).toContain("from '../../utils/slug'")
    expect(after("server/databases/schema/index.ts")).toBe("export * from './users'\n")
    expect(after("server/databases/config.ts")).toContain("dialect: 'postgresql'")
    expect(after("server/utils/db.ts")).toBe("import { users } from '~~/server/databases/schema'\nimport type { User } from '../databases/schema/users'\n\nexport { users }\n")
    expect(JSON.parse(after("package.json") ?? "{}")).toEqual({ dependencies: { "@vite-hub/database": "^0.1.0", "drizzle-orm": "^0.45.3", "vite-hub": "^0.1.0" } })
    expect(run.result.followUps.filter(followUp => followUp.file === "nuxt.config.ts").map(followUp => followUp.message)).toMatchInlineSnapshot(`
      [
        "hub.db also set driver: 'postgres-js'. ViteHub reads the connection, the Cloudflare binding, and the Drizzle options from server/databases/config.ts. Move them there by hand. See https://vitehub.dev/docs/database/configure.",
        "hub.kv was { driver: 'upstash' }. The codemod set kv: true, which uses the default driver of the preset. NuxtHub and ViteHub name drivers differently, so set the driver options under vitehub.kv by hand. See https://vitehub.dev/docs/kv.",
        "hub.dir set the local data folder. ViteHub keeps local data in .vitehub/data/. Set dataDir under vitehub to keep another folder. The codemod dropped it.",
      ]
    `)
  })
})
