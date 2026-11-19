import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"
import { parse } from "yaml"

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
      ".github/workflows/ci.yml": "jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          pnpm vitehub content show docs intro\n          pnpm vitehub project info\n",
    })
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("cli-get-list")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("cli-get-list")

    await runCodemod("cli-get-list", { cwd, dryRun: false })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).scripts).toEqual({
      agent: "vitehub agent get --agent support --json",
      attempts: "vitehub schedule runs get run_1",
      content: "pnpm vitehub content get docs intro --ref published",
      env: "vitehub env list --stage production && vitehub env list --json --url https://app.example.com",
      invocation: "vitehub agent invocations get inv_1",
      job: "vitehub queue jobs get job_1",
      outbox: "vitehub email outbox get msg_1 --text",
      project: "vitehub project get",
      runs: "vitehub schedule runs list nightly --limit 5",
      same: "vitehub schedule runs list nightly",
      workflow: "vitehub workflow runs get --json wrun_1 && vitehub workflow runs get wrun_2",
      workspace: "vitehub workspace get docs main",
    })
    expect(parse(await readFile(join(cwd, ".github/workflows/ci.yml"), "utf8")).jobs.test.steps[0].run).toBe("pnpm vitehub content get docs intro\npnpm vitehub project get\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("cli-get-list")
  })

  it("preserves targets and output, and reports non-equivalent calls by file", async () => {
    const before = [
      'vitehub workflow get "$RUN_ID" | jq -r .run.status',
      "vitehub workflow runs show --id run_1",
      `vitehub workflow runs show --input '{"id":"run_1"}'`,
      "vitehub schedule runs --id nightly --json",
      "vitehub schedule runs list-nightly --json",
      'vitehub env status --url "$APP_URL" | jq -e .ok',
      "vitehub env status --json",
      `vitehub env status --url https://app.example.com --timeout 100 --input '{}'`,
      "vitehub definitions list email --url https://app.example.com --json",
      "",
    ]
    const cwd = await project({ "scripts/check.sh": before.join("\n") })
    const { result } = await runCodemod("cli-get-list", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "scripts/check.sh"), "utf8")).toBe([
      'vitehub workflow runs get --json "$RUN_ID" | jq -r .run.status',
      "vitehub workflow runs get --run-id run_1",
      before[2],
      "vitehub schedule runs list --id nightly --json",
      "vitehub schedule runs list list-nightly --json",
      'vitehub env list --json --url "$APP_URL" | jq -e .ok',
      ...before.slice(6),
    ].join("\n"))
    expect(result.followUps.map(({ file, line }) => [file, line])).toEqual([3, 7, 8, 9].map(line => ["scripts/check.sh", line]))
  })

  it("does not treat descriptions, step inputs, quoted arguments or shell comments as calls", async () => {
    const manifest = { description: "vitehub content show", scripts: { fixture: 'grep -F "vitehub content show" fixtures/legacy-help.txt', read: "vitehub content show docs intro" } }
    const workflow = `jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: example/action@v1\n        with:\n          run: vitehub content show\n      - name: vitehub content show\n        run: vitehub content show docs intro\n`
    const shell = '# vitehub content show\nprintf "%s\\n" "vitehub content show"\ncat <<EOF\nvitehub content show\nEOF\n'
    const cwd = await project({ "package.json": JSON.stringify(manifest), ".github/workflows/ci.yaml": workflow, "fixture.sh": shell })
    await runCodemod("cli-get-list", { cwd, dryRun: false })
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))).toEqual({ ...manifest, scripts: { ...manifest.scripts, read: "vitehub content get docs intro" } })
    const updated = parse(await readFile(join(cwd, ".github/workflows/ci.yaml"), "utf8"))
    expect(updated.jobs.test.steps).toEqual([parse(workflow).jobs.test.steps[0], { name: "vitehub content show", run: "vitehub content get docs intro" }])
    expect(await readFile(join(cwd, "fixture.sh"), "utf8")).toBe(shell)
  })
})
