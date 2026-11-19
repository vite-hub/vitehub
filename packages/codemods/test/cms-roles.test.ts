import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/cms-roles-test/", import.meta.url))

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

describe("cms-roles", () => {
  it("renames access: 'roles' in the cms preset options, keeps the Content access, and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("cms-roles")
    const cwd = await project({
      "server/content.ts": "import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/cms'\nexport default defineContent({ extends: [cms, { repo: 'acme/site', access: 'roles' }], access: 'public', collections: {} })\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cms-roles")
    await runCodemod("cms-roles", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/content.ts"), "utf8")).toBe("import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/cms'\nexport default defineContent({ extends: [cms, { repo: 'acme/site', roles: true }], access: 'public', collections: {} })\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cms-roles")
  })

  it("reports an access value that it cannot rename, and leaves other presets alone", async () => {
    const cwd = await project({
      "server/content.ts": "import { cms as preset } from '@vite-hub/cms'\nimport other from './preset'\nexport const a = [preset, { access: mode }]\nexport const b = [other, { access: 'roles' }]\n",
    })
    const run = await runCodemod("cms-roles", { cwd, dryRun: true })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/content.ts", line: 3, message: expect.stringContaining("roles: true") })])
  })
})
