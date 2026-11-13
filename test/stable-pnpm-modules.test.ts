import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const root = new URL("..", import.meta.url)
const script = ".github/actions/setup/stable-pnpm-modules.mjs"

function normalize(modules: object) {
  const file = join(mkdtempSync(join(tmpdir(), "vitehub-modules-")), ".modules.yaml")
  writeFileSync(file, JSON.stringify(modules))
  const result = spawnSync(process.execPath, [script, file], { cwd: root, encoding: "utf8" })
  expect(result.status, result.stderr).toBe(0)
  return readFileSync(file, "utf8")
}

describe("stable pnpm modules state", () => {
  it("writes the same file for two installs of one lockfile", () => {
    const first = normalize({
      hoistedDependencies: { "zod@4.6.7": { zod: "private" }, "nuxt@4.5.2": { nuxt: "private" } },
      hoistPattern: ["*"],
      prunedAt: "Tue, 10 Nov 2026 08:41:49 GMT",
      virtualStoreDir: ".pnpm",
    })
    const second = normalize({
      virtualStoreDir: ".pnpm",
      prunedAt: "Tue, 10 Nov 2026 08:42:15 GMT",
      hoistPattern: ["*"],
      hoistedDependencies: { "nuxt@4.6.4": { nuxt: "private" }, "zod@4.6.7": { zod: "private" } },
    })
    expect(second).toBe(first)
    expect(JSON.parse(first)).toMatchObject({ virtualStoreDir: ".pnpm", hoistPattern: ["*"] })
  })

  it("runs in the setup action after the install and before any cached build", () => {
    const action = readFileSync(new URL(".github/actions/setup/action.yml", root), "utf8")
    const install = action.indexOf("run: vp install --frozen-lockfile")
    const stabilize = action.indexOf('run: node "$GITHUB_ACTION_PATH/stable-pnpm-modules.mjs"')
    const docs = action.indexOf("run: vp run --filter vitehub-docs postinstall")
    expect(install).toBeGreaterThan(-1)
    expect(stabilize).toBeGreaterThan(install)
    expect(docs).toBeGreaterThan(stabilize)
  })
})
