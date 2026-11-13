import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, formatReport, runCodemod, upgradeCodemods } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))
const scratch = fileURLToPath(new URL("../.tmp/renamed-apis-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("renamed-apis", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.flatMap(edit => edit.after === null ? [] : [[edit.path, edit.after]])), cwd, run }
}

describe("renamed-apis", () => {
  it("composes root accessors and API renames in the release upgrade", async () => {
    const { cwd } = await migrate({
      "server/api/a.ts": "import { deriveSecret } from '#vitehub/env/server'\nimport { db } from 'vite-hub/database/drizzle'\nimport { kv } from 'vite-hub/kv'\nexport const secret = deriveSecret('app', event)\nexport const remove = () => kv.del('a')\nexport { db }\n",
      "vite.config.ts": "import { hubDb } from '@vite-hub/database/vite'\nimport { hubKv } from '@vite-hub/kv/vite'\nexport default { plugins: [hubDb(), hubKv()] }\n",
    })
    for (const codemod of upgradeCodemods) await runCodemod(codemod.name, { cwd, dryRun: false })
    const route = await readFile(join(cwd, "server/api/a.ts"), "utf8")
    expect(route).toContain("from 'vite-hub/env'")
    expect(route).toContain("from 'vite-hub/database'")
    expect(route).toContain("deriveSecret('app', { event })")
    expect(route).toContain("kv.delete('a')")
    const config = await readFile(join(cwd, "vite.config.ts"), "utf8")
    expect(config).toContain("plugins: [hubDatabase(), hubKV()]")
    expect(await detectCodemods(cwd)).toEqual([])
  })

  it("migrates plugins, deletes, secrets, and operation names", async () => {
    const input = join(fixtures, "renamed-apis", "input")
    const run = await runCodemod("renamed-apis", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixtures, "renamed-apis", "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, "renamed-apis", "output", "report.txt"))
  })

  it("is detected for the migration wizard and not after the migration", async () => {
    const { cwd } = await migrate({ "server/api/a.ts": "import { kv } from 'vite-hub/kv'\nexport default () => kv.del('a')\n" })
    expect((await detectCodemods(cwd)).map(entry => [entry.codemod.name, entry.detection.reason])).toEqual([["renamed-apis", "server/api/a.ts uses del()"]])
    const current = await migrate({ "server/api/a.ts": "import { kv } from 'vite-hub/kv'\nexport default () => kv.delete('a')\n" })
    expect(await detectCodemods(current.cwd)).toEqual([])
  })

  it("keeps the import name when the file declares it again", async () => {
    const { after, run } = await migrate({
      "vite.config.ts": "import { hubKv } from '@vite-hub/kv/vite'\nfunction local(hubKv: unknown) { return hubKv }\nexport default { plugins: [hubKv()], local }\n",
    })
    expect(after["vite.config.ts"]).toBe("import { hubKV as hubKv } from '@vite-hub/kv/vite'\nfunction local(hubKv: unknown) { return hubKv }\nexport default { plugins: [hubKv()], local }\n")
    expect(run.result.followUps.map(entry => entry.message)).toEqual([expect.stringContaining("`hubKv` is also declared in this file")])
  })

  it("rewrites imported calls without changing shadowed local APIs", async () => {
    const source = [
      "import { deriveSecret } from '@vite-hub/env/server'",
      "import { kv } from 'vite-hub/kv'",
      "import { blob as files } from 'vite-hub/blob'",
      "deriveSecret('app', event)",
      "kv.del('a')",
      "kv.store('cache').del('a')",
      "files.store('media').del('a')",
      "function local(deriveSecret, kv, files) {",
      "  deriveSecret('local', event)",
      "  kv.del('a')",
      "  kv.store('cache').del('a')",
      "  files.store('media').del('a')",
      "}",
      "function hoisted() { kv.store('cache').del('a'); var kv }",
      "try {} catch (deriveSecret) { deriveSecret('local', event) }",
      "",
    ].join("\n")
    const { after } = await migrate({ "server/utils/apis.js": source })
    expect(after["server/utils/apis.js"]).toBe(source
      .replace("deriveSecret('app', event)", "deriveSecret('app', { event })")
      .replace("\nkv.del", "\nkv.delete")
      .replace("\nkv.store('cache').del", "\nkv.store('cache').delete")
      .replace("\nfiles.store('media').del", "\nfiles.store('media').delete"))
  })

  it.each([
    "import { console } from 'vite-hub/console/server'; console.log('a')",
    "import { console as panel } from 'vite-hub/console/server'; panel.log('a')",
    "export { console } from 'vite-hub/console/server'",
    "const { console } = await import('vite-hub/console/server'); console.log('a')",
    "const [{ console }] = await Promise.all([import('vite-hub/console/server')]); console.log('a')",
    "import { kv } from 'vite-hub/kv'; kv.store('cache').del('a')",
    "import { blob as files } from 'vite-hub/blob'; files.store('media').del('a')",
    "export const operation = 'kv.del'",
    "export const operation = 'blob.del'",
    "export const tool = 'kv_del'",
    "export const tool = 'blob_del'",
  ])("detects supported migration forms and stops after rewriting: %s", async (source) => {
    const { cwd, after } = await migrate({ "server/utils/apis.ts": source })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("renamed-apis")
    const migrated = await migrate(after)
    expect((await detectCodemods(migrated.cwd)).map(entry => entry.codemod.name)).not.toContain("renamed-apis")
  })

  it("renames an aliased import, a re-export, and a shorthand property", async () => {
    const { after } = await migrate({
      "plugins.ts": [
        "import { hubDb as database } from '@vite-hub/database/vite'",
        "import { hubKv } from '@vite-hub/kv/vite'",
        "export { hubDb } from '@vite-hub/database/nuxt'",
        "export const plugins = { database, hubKv }",
        "",
      ].join("\n"),
    })
    expect(after["plugins.ts"]).toBe([
      "import { hubDatabase as database } from '@vite-hub/database/vite'",
      "import { hubKV } from '@vite-hub/kv/vite'",
      "export { hubDatabase as hubDb } from '@vite-hub/database/nuxt'",
      "export const plugins = { database, hubKv: hubKV }",
      "",
    ].join("\n"))
  })

  it("leaves del() on other values and in files without a KV or Blob import", async () => {
    const { after, run } = await migrate({
      "server/api/a.ts": "const store = { del: (key: string) => key }\nexport default () => store.del('a')\n",
      "server/api/b.ts": "import { kv } from '@vite-hub/kv'\nconst handle = kv.store('cache')\nexport default () => handle.del('a')\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/api/b.ts", line: 3 })])
  })

  it("updates the event argument and drops an undefined one", async () => {
    const { after } = await migrate({
      "server/utils/secret.ts": [
        "import { deriveSecret } from '@vite-hub/env/server'",
        "export const a = (event: unknown) => deriveSecret('a', event)",
        "export const b = () => deriveSecret('b', undefined)",
        "export const c = (event: unknown) => deriveSecret('c', { event })",
        "",
      ].join("\n"),
    })
    expect(after["server/utils/secret.ts"]).toBe([
      "import { deriveSecret } from '@vite-hub/env/server'",
      "export const a = (event: unknown) => deriveSecret('a', { event })",
      "export const b = () => deriveSecret('b')",
      "export const c = (event: unknown) => deriveSecret('c', { event })",
      "",
    ].join("\n"))
  })

  it("lists a NUXT_APP_SECRET env file without printing its value", async () => {
    const { run } = await migrate({ ".env": "OTHER=1\nNUXT_APP_SECRET=do-not-print-this-value\n", ".dev.vars": "NUXT_APP_SECRET=x\nVITEHUB_SECRET=y\n" })
    expect(run.result.followUps).toEqual([{ file: ".env", line: 2, message: expect.stringContaining("Set `VITEHUB_SECRET`") }])
    expect(formatReport(run)).not.toContain("do-not-print-this-value")
  })
})
