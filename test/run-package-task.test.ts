import { execFile, spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "..")
const runner = join(repoRoot, "test/run-package-task.mjs")
const fixtureRoot = join(repoRoot, "test/fixtures/package-task-workspace")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function tempFile(name: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-package-task-"))
  roots.push(root)
  return join(root, name)
}

async function runFixture(packages: string[], env: NodeJS.ProcessEnv = {}) {
  const log = await tempFile("events.log")
  const summary = await tempFile("summary.md")
  await writeFile(log, "")
  await writeFile(summary, "")

  try {
    const args = [
      runner,
      "test",
      "--workspace",
      fixtureRoot,
      "--packages",
      packages.join(","),
      "--max-parallel",
      "2",
    ]
    const result = await execFileAsync(process.execPath, args, {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summary,
        VITEHUB_FIXTURE_LOG: log,
        ...env,
      },
    })
    return { ...result, code: 0, log: await readFile(log, "utf8"), summary: await readFile(summary, "utf8") }
  }
  catch (error) {
    // SAFETY: execFile rejects with an ExecFileException augmented with the captured output.
    const failure = error as Error & { code: number, stderr: string, stdout: string }
    return { code: failure.code, stderr: failure.stderr, stdout: failure.stdout, log: await readFile(log, "utf8"), summary: await readFile(summary, "utf8") }
  }
}

describe("package task runner", () => {
  it.each([
    "",
    "vp run -t @fixture/compound#build && ",
    "vp run -t @fixture/shared#build && vp run -t @fixture/compound#build && ",
  ])("runs all test commands without replaying completed builds: %s", async (buildPrefix) => {
    const log = await tempFile("events.log")
    const workspace = join(log, "..")
    const packageDir = join(workspace, "packages/compound")
    const binDir = join(workspace, "node_modules/.bin")
    await mkdir(packageDir, { recursive: true })
    await mkdir(binDir, { recursive: true })
    await writeFile(join(workspace, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@10.33.0" }))
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
    await writeFile(join(packageDir, "package.json"), JSON.stringify({
      name: "@fixture/compound",
      dependencies: { "@fixture/shared": "workspace:*" },
      scripts: { build: "vp pack compound", test: `${buildPrefix}vp test && vp test --config workerd.config.ts` },
    }))
    const sharedDir = join(workspace, "packages/shared")
    await mkdir(sharedDir, { recursive: true })
    await writeFile(join(sharedDir, "package.json"), JSON.stringify({
      name: "@fixture/shared",
      scripts: { build: "vp pack shared" },
    }))
    const fakeVp = join(binDir, "vp")
    await writeFile(fakeVp, [
      "#!/usr/bin/env node",
      'const { appendFileSync } = require("node:fs")',
      'appendFileSync(process.env.VITEHUB_FIXTURE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n")',
      'if (process.argv.includes("--config")) process.exitCode = 7',
    ].join("\n"))
    await chmod(fakeVp, 0o755)
    await writeFile(`${fakeVp}.cmd`, `@node "${fakeVp}" %*`)

    const result = await execFileAsync(process.execPath, [runner, "test", "--workspace", workspace], {
      env: { ...process.env, VITEHUB_FIXTURE_LOG: log },
    }).then(result => ({ ...result, code: 0 }), (error: Error & { code: number, stdout: string }) => error)

    expect(result.code, result.stdout).toBe(7)
    expect(await readFile(log, "utf8")).toBe('["pack","shared"]\n["pack","compound"]\n["test"]\n["test","--config","workerd.config.ts"]\n')
    expect(result.stdout).toContain("FAIL @fixture/compound")
  }, 30_000)

  it("aggregates independent failures, skips dependents, and builds the diamond once", async () => {
    const result = await runFixture(
      ["@fixture/app", "@fixture/core", "@vite-hub/env", "@vite-hub/markdown-template", "@vite-hub/runtime"],
      { VITEHUB_FIXTURE_DELAY: "500", VITEHUB_FIXTURE_FAILURES: "@vite-hub/env=3,@vite-hub/markdown-template=7" },
    )

    expect(result.code).toBe(1)
    expect(result.stdout).toContain("FAIL @vite-hub/env")
    expect(result.stdout).toContain("FAIL @vite-hub/markdown-template")
    expect(result.stdout).toContain("SKIP @fixture/app")
    expect(result.summary).toContain("| @vite-hub/env | passed | failed (exit 3) |")
    expect(result.summary).toContain("| @vite-hub/markdown-template | passed | failed (exit 7) |")
    expect(result.summary).toContain("| @fixture/app | passed | skipped")

    const events = result.log.trim().split("\n")
    for (const name of ["@fixture/app", "@fixture/core", "@vite-hub/env", "@vite-hub/markdown-template", "@vite-hub/runtime"]) {
      expect(events.filter(event => event === `build:start:${name}`)).toHaveLength(1)
    }
    expect(events).not.toContain("test:start:@fixture/app")
    const lastStart = Math.max(
      events.indexOf("test:start:@vite-hub/env"),
      events.indexOf("test:start:@vite-hub/markdown-template"),
    )
    const firstEnd = Math.min(
      events.indexOf("test:end:@vite-hub/env"),
      events.indexOf("test:end:@vite-hub/markdown-template"),
    )
    expect(lastStart).toBeLessThan(firstEnd)

    const rows = result.stdout.split("\n").filter(line => /^(?:PASS|FAIL|SKIP) @(?:fixture|vite-hub)\//.test(line))
    expect(rows.map(row => row.split(" ")[1])).toEqual([
      "@fixture/app",
      "@fixture/core",
      "@vite-hub/env",
      "@vite-hub/markdown-template",
      "@vite-hub/runtime",
    ])
  }, 30_000)

  it("keeps packages outside the safe allowlist serial", async () => {
    const result = await runFixture(["@fixture/serial-a", "@fixture/serial-b"], { VITEHUB_FIXTURE_DELAY: "20" })

    expect(result.code).toBe(0)
    expect(result.log.trim().split("\n")).toEqual([
      "build:start:@fixture/serial-a",
      "build:end:@fixture/serial-a",
      "build:start:@fixture/serial-b",
      "build:end:@fixture/serial-b",
      "test:start:@fixture/serial-a",
      "test:end:@fixture/serial-a",
      "test:start:@fixture/serial-b",
      "test:end:@fixture/serial-b",
    ])
  })

  it("skips a package test and its dependents after its build fails", async () => {
    const result = await runFixture(
      ["@fixture/app", "@vite-hub/env"],
      { VITEHUB_FIXTURE_BUILD_FAILURES: "@vite-hub/env=5" },
    )

    expect(result.code).toBe(5)
    expect(result.summary).toContain("| @vite-hub/env | failed (exit 5) | skipped: build did not pass |")
    expect(result.summary).toContain("| @fixture/app | skipped: dependency @vite-hub/env did not pass | skipped: build did not pass |")
    expect(result.log).not.toContain("test:start:@vite-hub/env")
    expect(result.log).not.toContain("test:start:@fixture/app")
  })

  it("propagates a package signal as the aggregate exit status", async () => {
    const result = await runFixture(["@vite-hub/runtime"], { VITEHUB_FIXTURE_SIGNALS: "@vite-hub/runtime" })

    expect(result.code).toBe(143)
    expect(result.stdout).toContain("failed (exit 143)")
  })

  it("forwards interruption to the active package and stops scheduling", async () => {
    const log = await tempFile("interrupt.log")
    await writeFile(log, "")
    const child = spawn(process.execPath, [
      runner,
      "test",
      "--workspace",
      fixtureRoot,
      "--packages",
      "@fixture/interrupt,@fixture/serial-a",
    ], {
      cwd: fixtureRoot,
      env: { ...process.env, VITEHUB_FIXTURE_DELAY: "10000", VITEHUB_FIXTURE_LOG: log },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    child.stdout.on("data", chunk => stdout += chunk)

    await expect.poll(async () => readFile(log, "utf8"), { timeout: 5_000 }).toContain("build:start:@fixture/interrupt")
    child.kill("SIGTERM")
    const code = await new Promise<number | null>(resolve => child.on("close", resolve))

    expect(code).toBe(143)
    expect(await readFile(log, "utf8")).toContain("build:signal:@fixture/interrupt")
    expect(stdout).toContain("SKIP @fixture/serial-a")
  }, 10_000)
})
