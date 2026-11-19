import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/cli-get-list-test/", import.meta.url))

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

describe("cli-get-list", () => {
  it("renames the read commands of scripts and CI to get and list", async () => {
    const scripts = {
      agent: "vitehub agent info --agent support --json",
      attempts: "vitehub schedule attempts run_1",
      content: "pnpm vitehub content show docs intro --ref published",
      env: "vitehub env inspect --stage production && vitehub env status --url https://app.example.com",
      invocation: "vitehub agent invocations show inv_1",
      job: "vitehub queue jobs show job_1",
      outbox: "vitehub email outbox show msg_1 --text",
      project: "vitehub project info",
      runs: "vitehub schedule runs nightly --limit 5",
      same: "vitehub schedule runs list nightly",
      workflow: "vitehub workflow get wrun_1 && vitehub workflow runs show wrun_2",
      workspace: "vitehub workspace show docs main",
    }
    const cwd = await project({
      "package.json": `${JSON.stringify({ scripts }, null, 2)}\n`,
      ".github/workflows/ci.yml": "steps:\n  - run: pnpm vitehub definitions list\n",
    })
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("cli-get-list")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cli-get-list")

    await runCodemod("cli-get-list", { cwd, dryRun: false })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts).toEqual({
      agent: "vitehub agent get --agent support --json",
      attempts: "vitehub schedule runs get run_1",
      content: "pnpm vitehub content get docs intro --ref published",
      env: "vitehub env list --stage production && vitehub env list --url https://app.example.com",
      invocation: "vitehub agent invocations get inv_1",
      job: "vitehub queue jobs get job_1",
      outbox: "vitehub email outbox get msg_1 --text",
      project: "vitehub project get",
      runs: "vitehub schedule runs list nightly --limit 5",
      same: "vitehub schedule runs list nightly",
      workflow: "vitehub workflow runs get wrun_1 && vitehub workflow runs get wrun_2",
      workspace: "vitehub workspace get docs main",
    })
    expect(await readFile(join(cwd, ".github/workflows/ci.yml"), "utf8")).toContain("- run: pnpm vitehub inspect definitions\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cli-get-list")
  })
})
