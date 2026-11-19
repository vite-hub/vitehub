import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"
import { readCmsOptions } from "./cms-roles-reader.mjs"

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
      "server/content.ts": "import { defineContent } from '@vite-hub/content'\nimport { cms as preset } from '@vite-hub/cms'\nimport other from './preset'\nexport default defineContent({ extends: [preset, { access: mode }] })\nexport const otherContent = defineContent({ extends: [other, { access: 'roles' }] })\n",
    })
    const run = await runCodemod("cms-roles", { cwd, dryRun: true })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/content.ts", line: 4, message: expect.stringContaining("roles: true") })])
  })

  it("changes only the extends tuple of the imported defineContent with the imported preset", async () => {
    const unrelated = `
const data = new Map([[cms, { access: 'roles' }]])
const tuple = (cms: string) => [cms, { access: 'roles' }]
const shadowedPreset = (cms: string) => defineContent({ extends: [cms, { access: 'roles' }] })
const shadowedDefine = (defineContent: Function) => defineContent({ extends: [cms, { access: 'roles' }] })
const otherOption = defineContent({ data: [cms, { access: 'roles' }] })
`
    const definition = "export default defineContent({ extends: [cms, { access: 'roles' }] })"
    const imports = "import { defineContent } from 'vite-hub/content'\nimport cms from 'vite-hub/cms'\n"
    const cwd = await project({ "server/content.ts": imports + unrelated + definition })
    const run = await runCodemod("cms-roles", { cwd, dryRun: true })
    expect(run.result.edits.map(edit => edit.after)).toEqual([imports + unrelated + definition.replace("access: 'roles'", "roles: true")])
    expect(run.result.followUps).toEqual([])
  })

  it.each([
    ["import * as presets from 'vite-hub/cms'", "presets.default"],
    ["import * as presets from '@vite-hub/cms'", "(presets.cms satisfies Preset)"],
    ["import { default as preset } from 'vite-hub/cms'", "preset"],
    ["import cms from 'vite-hub/cms'", "<Preset>cms"],
  ])("migrates %s with reference %s and feeds the build reader", async (importPreset, reference) => {
    const code = `import { defineContent as content } from 'vite-hub/content'\n${importPreset}\nexport default content({ extends: [${reference}, { access: 'roles' }] })\n`
    const cwd = await project({ "server/content.ts": code })
    const file = join(cwd, "server/content.ts")
    expect(() => readCmsOptions(code, file, cwd)).toThrow('Replace `access: "roles"` with `roles: true`')
    const run = await runCodemod("cms-roles", { cwd, dryRun: false })
    expect(run.result.followUps).toEqual([])
    expect(readCmsOptions(await readFile(file, "utf8"), file, cwd)).toEqual({ roles: true })
  })
})
