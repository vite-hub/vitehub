import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/cli-agent-tree-test/", import.meta.url))

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

describe("cli-agent-tree", () => {
  it("moves the Agent calls of scripts and CI under vitehub agent", async () => {
    const cwd = await project({
      "package.json": `${JSON.stringify({ scripts: {
        export: "vitehub conversations export support web t1 --format json --output out",
        get: "vitehub agent get --agent support --json",
        invoke: "vitehub agents invoke support --prompt hi",
        list: "vitehub agents list --url https://app.example.com",
        read: "vitehub invocations get inv_1 && vitehub invocations workspace inv_1",
        status: "vitehub agents status --agent=support",
      } }, null, 2)}\n`,
      ".github/workflows/ci.yml": "steps:\n  - run: pnpm vitehub invocations list --url https://app.example.com\n",
    })
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("cli-agent-tree")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cli-agent-tree")

    await runCodemod("cli-agent-tree", { cwd, dryRun: false })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts).toEqual({
      export: "vitehub agent conversations export support web t1 --format json --output out",
      get: "vitehub agent get support --json",
      invoke: "vitehub agent invoke support --prompt hi",
      list: "vitehub agent list --url https://app.example.com",
      read: "vitehub agent invocations get inv_1 && vitehub agent invocations workspace inv_1",
      status: "vitehub agent get support",
    })
    expect(await readFile(join(cwd, ".github/workflows/ci.yml"), "utf8")).toContain("- run: pnpm vitehub agent invocations list --url https://app.example.com\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cli-agent-tree")
  })
})
