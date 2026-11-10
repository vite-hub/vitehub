import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"

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

  it("lets the setup action opt out, and only jobs that never touch the docs do", () => {
    const action = readFileSync(new URL(".github/actions/setup/action.yml", root), "utf8")
    expect(action).toMatch(/VITEHUB_SKIP_DOCS_PREPARE: "1"\n\s+run: vp install --frozen-lockfile/)
    expect(action).toMatch(/if: inputs\.prepare-docs != 'false'\n\s+shell: bash\n\s+run: vp run --filter vitehub-docs postinstall/)
    const ci = parseYaml(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8")) as { jobs: Record<string, { steps: { uses?: string, with?: Record<string, string> }[] }> }
    const optedOut = Object.entries(ci.jobs)
      .filter(([, job]) => job.steps.some(step => step.uses === "./.github/actions/setup" && step.with?.["prepare-docs"] === "false"))
      .map(([name]) => name)
    expect(optedOut.toSorted()).toEqual(["console", "package-tests"])
  })
})
