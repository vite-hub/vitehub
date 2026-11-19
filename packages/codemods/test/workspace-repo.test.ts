import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/workspace-repo-test/", import.meta.url))

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

describe("workspace-repo", () => {
  it("renames repository to repo on GitHub Workspace Stores, and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("workspace-repo")
    const cwd = await project({
      "server/workspaces/handbook.ts": "import { defineWorkspace } from 'vite-hub/workspace'\nexport default defineWorkspace({\n  store: {\n    driver: 'github',\n    repository: 'acme/handbook',\n    branch: 'main',\n  },\n})\n",
      "vite.config.ts": "import { vitehub } from 'vite-hub'\nconst repository = () => process.env.REPO\nexport default { plugins: [vitehub({ workspace: { store: { driver: 'github', repository } } })] }\n",
      "server/api/forge.ts": "export const target = { forge: 'github', repository: 'acme/app' }\n",
      "server/release.ts": "const release = { driver: 'github', repository: 'acme/app' }; export default release.repository\n",
      "server/shadowed.ts": "import { defineWorkspace } from 'vite-hub/workspace'\nexport const release = (defineWorkspace) => defineWorkspace({ store: { driver: 'github', repository: 'acme/app' } })\n",
      "server/workspaces/alias.ts": "import { defineWorkspace as workspace } from '@vite-hub/workspace'\nexport default workspace({ store: { 'driver': 'github' as const, 'repository' /* keep */: (check(), 'acme/app') } })\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("workspace-repo")
    const run = await runCodemod("workspace-repo", { cwd, dryRun: false })
    expect(run.result.edits.map(edit => edit.path)).toEqual(["server/workspaces/alias.ts", "server/workspaces/handbook.ts", "vite.config.ts"])
    expect(await readFile(join(cwd, "server/workspaces/alias.ts"), "utf8")).toContain("'repo' /* keep */: (check(), 'acme/app')")
    expect(await readFile(join(cwd, "server/workspaces/handbook.ts"), "utf8")).toContain("    repo: 'acme/handbook',\n")
    expect(await readFile(join(cwd, "vite.config.ts"), "utf8")).toContain("store: { driver: 'github', repo: repository }")
    expect(await readFile(join(cwd, "server/api/forge.ts"), "utf8")).toBe("export const target = { forge: 'github', repository: 'acme/app' }\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("workspace-repo")
  })

  it("reports stores whose repository precedence needs manual migration", async () => {
    const cwd = await project({
      "server/workspaces/docs.ts": `import { defineWorkspace } from 'vite-hub/workspace'
const defaults = { repo: 'acme/default' }
const key = 'repo'
export const both = defineWorkspace({ store: { driver: 'github', repo: 'acme/default', repository: 'acme/docs' } })
export const spread = defineWorkspace({ store: { driver: 'github', repository: 'acme/docs', ...defaults } })
export const computed = defineWorkspace({ store: { driver: 'github', repository: 'acme/docs', [key]: 'acme/default' } })
`,
    })
    const run = await runCodemod("workspace-repo", { cwd, dryRun: true })
    expect(run.result.edits).toEqual([])
    expect(run.result.followUps.map(followUp => followUp.line)).toEqual([4, 5, 6])
    for (const followUp of run.result.followUps) expect(followUp.message).toContain("previously effective repository")
  })
})
