import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/cli-url-flag-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function project(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  return cwd
}

describe("cli-url-flag", () => {
  it("moves the vitehub calls of scripts and CI from --server to --url", async () => {
    const cwd = await project({
      "package.json": `${JSON.stringify({ scripts: {
        cancel: "vitehub agent invocations cancel inv_1 --server http://localhost:3000",
        replay: "pnpm vitehub channels replay --agent a --channel c --server=http://localhost:3000 --dry-run",
        serve: "nuxt dev --server http://x",
      } }, null, 2)}\n`,
      ".github/workflows/ci.yml": "steps:\n  - run: pnpm vitehub workspace dev docs exec ls --server http://localhost:3000\n",
    })
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("cli-url-flag")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cli-url-flag")

    await runCodemod("cli-url-flag", { cwd, dryRun: false })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts).toEqual({
      cancel: "vitehub agent invocations cancel inv_1 --url http://localhost:3000",
      replay: "pnpm vitehub channels replay --agent a --channel c --url=http://localhost:3000 --dry-run",
      serve: "nuxt dev --server http://x",
    })
    expect(await readFile(join(cwd, ".github/workflows/ci.yml"), "utf8")).toContain("exec ls --url http://localhost:3000\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cli-url-flag")
  })
})
