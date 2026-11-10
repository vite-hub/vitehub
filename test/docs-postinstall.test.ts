import { spawnSync } from "node:child_process"

import { describe, expect, it } from "vitest"

const root = new URL("..", import.meta.url)

describe("docs postinstall", () => {
  it("skips the docs build and nuxi prepare when CI opts out", () => {
    const result = spawnSync(process.execPath, ["docs/scripts/postinstall.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: "", VITEHUB_SKIP_DOCS_PREPARE: "1" },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Skipping the docs build and nuxi prepare")
  })
})
