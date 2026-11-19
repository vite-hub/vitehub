import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"
import { parse } from "yaml"

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
        get: "vitehub agent get --json --agent support",
        getFromDev: "vitehub agent get --url https://dev.example.com --agent=support",
        invoke: "vitehub agents invoke support --prompt hi",
        list: "vitehub agents list --url https://app.example.com",
        read: "vitehub invocations workspace inv_1 --path README.md",
        status: 'vitehub agents status --url "$APP_URL" --agent "support"',
      } }, null, 2)}\n`,
      ".github/workflows/ci.yml": "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm vitehub invocations cancel inv_1 --url https://app.example.com\n",
    })
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("cli-agent-tree")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cli-agent-tree")

    await runCodemod("cli-agent-tree", { cwd, dryRun: false })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts).toEqual({
      export: "vitehub agent conversations export support web t1 --format json --output out",
      get: "vitehub agent get support --json",
      getFromDev: "vitehub agent get support --server https://dev.example.com",
      invoke: "vitehub agent invoke support --prompt hi",
      list: "vitehub agent list --url https://app.example.com",
      read: "vitehub agent invocations workspace inv_1 --path README.md",
      status: 'vitehub agent get "support" --url "$APP_URL"',
    })
    const workflow = parse(await readFile(join(cwd, ".github/workflows/ci.yml"), "utf8"))
    expect(workflow.jobs.check.steps[0].run).toBe("pnpm vitehub agent invocations cancel inv_1 --url https://app.example.com")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cli-agent-tree")
  })

  it("reports commands it cannot migrate without changing their target or contract", async () => {
    const script = "vitehub invocations delete inv_1 --yes\nvitehub invocations list --agent support --cursor next\nvitehub invocations get inv_1 --json\nvitehub agents status --agent support\nvitehub agent get --json --agent \"$AGENT\"\n"
    const cwd = await project({ "scripts/inspect.sh": script })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cli-agent-tree")
    const { result } = await runCodemod("cli-agent-tree", { cwd, dryRun: false })
    expect(result.followUps).toEqual([
      { file: "scripts/inspect.sh", line: 1, message: expect.stringContaining("deletes from the journal file") },
      { file: "scripts/inspect.sh", line: 2, message: expect.stringContaining("Console cursor") },
      { file: "scripts/inspect.sh", line: 3, message: expect.stringContaining("flat record") },
      { file: "scripts/inspect.sh", line: 4, message: expect.stringContaining("Move --agent to the name") },
      { file: "scripts/inspect.sh", line: 5, message: expect.stringContaining("Move --agent to the name") },
    ])
    expect(await readFile(join(cwd, "scripts/inspect.sh"), "utf8")).toBe(script)
  })
})
