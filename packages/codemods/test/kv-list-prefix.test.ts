import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/kv-list-prefix-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function project(files: Record<string, string>): Promise<string> {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  return cwd
}

describe("kv-list-prefix", () => {
  it("moves keys() and clear(base) to the prefix options, keeps the keys below base, and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("kv-list-prefix")
    const cwd = await project({
      "server/api/drafts.ts": [
        "import { kv } from 'vite-hub/kv'",
        "export default async () => {",
        "  const [error, keys] = await kv.keys('drafts')",
        "  const [allError, all] = await kv.keys()",
        "  await kv.clear('drafts')",
        "  await kv.store('sessions').clear('users:')",
        "  await kv.clear()",
        "  return { error, keys, allError, all }",
        "}",
        "",
      ].join("\n"),
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("kv-list-prefix")
    const run = await runCodemod("kv-list-prefix", { cwd, dryRun: false })
    expect(run.result.followUps).toEqual([])
    expect(await readFile(join(cwd, "server/api/drafts.ts"), "utf8")).toBe([
      "import { kv } from 'vite-hub/kv'",
      "export default async () => {",
      "  const [error, { keys } = { keys: [] }] = await kv.list({ prefix: 'drafts:' })",
      "  const [allError, { keys: all } = { keys: [] }] = await kv.list()",
      "  await kv.clear({ prefix: 'drafts:' })",
      "  await kv.store('sessions').clear({ prefix: 'users:' })",
      "  await kv.clear()",
      "  return { error, keys, allError, all }",
      "}",
      "",
    ].join("\n"))
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("kv-list-prefix")
  })

  it("reports keys() and clear(base) calls that it cannot move, and leaves other values alone", async () => {
    const cwd = await project({
      "server/utils/cache.ts": [
        "import { kv } from '@vite-hub/kv'",
        "const store = kv.store('cache')",
        "export const list = () => store.keys()",
        "export const drop = (base: string) => kv.clear(base)",
        "export const other = new Map().keys()",
        "",
      ].join("\n"),
    })
    const run = await runCodemod("kv-list-prefix", { cwd, dryRun: true })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps.map(followUp => followUp.line)).toEqual([3, 4])
  })
})
