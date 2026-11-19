import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/cli-yes-flag-test/", import.meta.url))

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

describe("cli-yes-flag", () => {
  it("moves the vitehub calls of scripts, CI, and shell files to --yes", async () => {
    const cwd = await project({
      "package.json": `${JSON.stringify({ scripts: {
        "db:fresh": "vitehub database reset --force && vitehub seed database",
        "db:drop": "pnpm vitehub database drop --remote --force",
        "db:generate": "vitehub database generate --name init --non-interactive",
        "logout:mail": "vitehub connections revoke mail --confirm mail --url https://app.example.com",
        "clean": "rm -rf dist --force",
      } }, null, 2)}\n`,
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: pnpm vitehub database drop --force\n",
      "scripts/reset.sh": "#!/bin/sh\nvitehub connections revoke mail --confirm=mail; vitehub database reset --force\n",
    })
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("cli-yes-flag")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cli-yes-flag")

    await runCodemod("cli-yes-flag", { cwd, dryRun: false })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts).toEqual({
      "db:fresh": "vitehub database reset --yes && vitehub seed database",
      "db:drop": "pnpm vitehub database drop --remote --yes",
      "db:generate": "vitehub database generate --name init",
      "logout:mail": "vitehub connections revoke mail --yes --url https://app.example.com",
      "clean": "rm -rf dist --force",
    })
    expect(await readFile(join(cwd, ".github/workflows/ci.yml"), "utf8")).toContain("- run: pnpm vitehub database drop --yes\n")
    expect(await readFile(join(cwd, "scripts/reset.sh"), "utf8")).toBe("#!/bin/sh\nvitehub connections revoke mail --yes; vitehub database reset --yes\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cli-yes-flag")
  })

  it("keeps --force where it overrides a check", async () => {
    const cwd = await project({
      "package.json": `${JSON.stringify({ scripts: { off: "vitehub remove queue --force", replay: "vitehub channels replay --agent a --channel c --force" } })}\n`,
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cli-yes-flag")
  })
})
