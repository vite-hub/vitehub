import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { findServiceTests, groupByPackage, packageBuilds } from "./service-tests.mjs"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-service-tests-"))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["add", "."], { cwd: root })
  return root
}

describe("service tests", () => {
  it("selects package test files that read a service variable, whatever their name", async () => {
    const root = await repository({
      "packages/kv/test/shared-drivers.test.ts": "const url = process.env.VITEHUB_TEST_REDIS_URL",
      "packages/queue/test/fixtures/worker.ts": "const url = process.env.VITEHUB_TEST_POSTGRES_URL",
      "packages/queue/test/unit.test.ts": "it('runs without services', () => {})",
      "packages/runtime/test/lease/sql.test.ts": "const url = process.env.VITEHUB_TEST_POSTGRES_URL",
      "test/root.test.ts": "const url = process.env.VITEHUB_TEST_POSTGRES_URL",
    })

    const files = findServiceTests(root)

    expect(files).toEqual(["packages/kv/test/shared-drivers.test.ts", "packages/runtime/test/lease/sql.test.ts"])
    expect([...groupByPackage(files)]).toEqual([
      ["packages/kv", ["test/shared-drivers.test.ts"]],
      ["packages/runtime", ["test/lease/sql.test.ts"]],
    ])
  })

  it("finds nothing when no test reads a service variable", async () => {
    const root = await repository({ "packages/kv/test/unit.test.ts": "it('works', () => {})" })

    expect(findServiceTests(root)).toEqual([])
  })

  it("runs the builds that a package test script runs first", () => {
    expect(packageBuilds("vp run -t @vite-hub/workflow#build && vp run -t @vite-hub/agent#build && vp test"))
      .toEqual(["@vite-hub/workflow", "@vite-hub/agent"])
    expect(packageBuilds("vp run --cache -t @vite-hub/workflow#build && vp run --cache -t @vite-hub/agent#build && vp test"))
      .toEqual(["@vite-hub/workflow", "@vite-hub/agent"])
    expect(packageBuilds("vp test")).toEqual([])
  })
})
