import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, runMigration, upgradeCodemods } from "../src/index.ts"

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
        replay: 'pnpm vitehub channels replay --agent "a" --channel c --server=http://localhost:3000 --dry-run',
        delegated: "vitehub workspace dev docs exec my-tool --server localhost && vitehub agent dev --cli tool -- --server localhost",
        direct: "vitehub agent dev '!my-tool' --server localhost",
        unrelated: "acme-vitehub dev --server localhost; echo 'vitehub agent dev --server localhost'",
        serve: "nuxt dev --server http://x",
      } }, null, 2)}\n`,
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: pnpm exec vitehub workspace dev docs --server http://localhost:3000 exec ls\n",
    })
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("cli-url-flag")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cli-url-flag")

    await runCodemod("cli-url-flag", { cwd, dryRun: false })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts).toEqual({
      cancel: "vitehub agent invocations cancel inv_1 --url http://localhost:3000",
      replay: 'pnpm vitehub channels replay --agent "a" --channel c --url=http://localhost:3000 --dry-run',
      delegated: "vitehub workspace dev docs exec my-tool --server localhost && vitehub agent dev --cli tool -- --server localhost",
      direct: "vitehub agent dev '!my-tool' --server localhost",
      unrelated: "acme-vitehub dev --server localhost; echo 'vitehub agent dev --server localhost'",
      serve: "nuxt dev --server http://x",
    })
    expect(await readFile(join(cwd, ".github/workflows/ci.yml"), "utf8")).toContain("docs --url http://localhost:3000 exec ls\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cli-url-flag")
  })

  it("migrates a connection command that uses both removed flags", async () => {
    const cwd = await project({ "package.json": JSON.stringify({ scripts: {
      revoke: 'vitehub connections revoke mail --confirm "mail" --server http://localhost:3000',
    } }) })
    const migration = await runMigration({ cwd, codemods: upgradeCodemods })
    expect(migration.steps.filter(step => step.codemod.name.startsWith("cli-")).map(step => step.codemod.name)).toEqual(["cli-url-flag", "cli-yes-flag"])
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts.revoke).toBe("vitehub connections revoke mail --yes --url http://localhost:3000")
  })

  it("reports ambiguous shell syntax rather than editing heredoc data", async () => {
    const script = "#!/bin/sh\ncat <<EOF\nvitehub agent dev --server http://localhost:3000\nEOF\n"
    const cwd = await project({ "example.sh": script })
    const { result } = await runCodemod("cli-url-flag", { cwd, dryRun: false })
    expect(result.followUps).toEqual([expect.objectContaining({ file: "example.sh" })])
    expect(await readFile(join(cwd, "example.sh"), "utf8")).toBe(script)
  })
})
