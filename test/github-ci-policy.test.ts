import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  checkGitHubCIInputs,
  findUnpinnedExecutors,
  inspectWorkflow,
} from "../.github/scripts/check-ci-inputs.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const scriptPath = resolve(repoRoot, ".github/scripts/check-ci-inputs.mjs")

function workflow(steps: string, env = "") {
  return `${env}jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`
}

describe("GitHub CI input policy", () => {
  it("passes on the repository workflows and composite actions", () => {
    expect(checkGitHubCIInputs(repoRoot)).toEqual([])
  })

  it.each([
    "npx eslint .",
    "pnpm dlx vercel deploy",
    "vp dlx \"vercel@latest\" link",
    "bunx prettier@^3 --check .",
    "bun x tsx script.ts",
    "npm exec --package=create-vite -- create-vite app",
    "yarn dlx -p cowsay cowsay hi",
    "cd docs && npx nuxi@3 build",
  ])("rejects an unpinned executor: %s", (command) => {
    expect(findUnpinnedExecutors(command)).not.toEqual([])
  })

  it.each([
    "sh -c 'npx cowsay hello'",
    'bash -c "pnpm dlx cowsay hello"',
  ])("rejects an unpinned executor inside quoted shell text: %s", (command) => {
    expect(findUnpinnedExecutors(command)).not.toEqual([])
  })

  it.each([
    "npx eslint@9.1.0 .",
    "pnpm dlx @vercel/cli@54.5.1 deploy",
    "vp dlx \"vercel@54.5.1\" link --yes",
    "bunx --bun tsx@4.19.0-beta.1 script.ts",
    "npm exec -p create-vite@6.0.0 -c 'create-vite app'",
    "npm install -g netlify-cli && pnpm install",
  ])("allows an exact executor version: %s", (command) => {
    expect(findUnpinnedExecutors(command)).toEqual([])
  })

  it("resolves versions from workflow, job, and step env", () => {
    const source = [
      "env:\n  WORKFLOW_VERSION: 1.0.0\n",
      "jobs:\n  test:\n    env:\n      JOB_VERSION: 2.0.0\n    steps:\n",
      "      - run: npx a@$WORKFLOW_VERSION && npx b@${JOB_VERSION} && npx c@$STEP_VERSION\n",
      "        env:\n          STEP_VERSION: 3.0.0\n",
    ].join("")

    expect(inspectWorkflow("ci.yml", source)).toEqual([])
  })

  it("rejects versions that come from an expression or an unknown variable", () => {
    const source = workflow(
      "      - run: npx a@$FROM_INPUT && npx b@$UNKNOWN\n        env:\n          FROM_INPUT: ${{ inputs.version }}\n",
    )

    expect(inspectWorkflow("ci.yml", source)).toEqual([
      "ci.yml: test step 1: transient package executor must use an exact version: a@$FROM_INPUT",
      "ci.yml: test step 1: transient package executor must use an exact version: b@$UNKNOWN",
    ])
  })

  it("checks composite action steps", () => {
    const source = "runs:\n  using: composite\n  steps:\n    - name: Lint\n      shell: bash\n      run: npx eslint .\n"

    expect(inspectWorkflow("action.yml", source)).toEqual([
      "action.yml: composite action step Lint: transient package executor must use an exact version: eslint",
    ])
  })

  it("requires a sha256 digest on Docker actions", () => {
    const digest = `sha256:${"a".repeat(64)}`
    const source = workflow(`      - uses: docker://alpine:3.20\n      - uses: docker://alpine:3.20@${digest}\n`)

    expect(inspectWorkflow("ci.yml", source)).toEqual([
      "ci.yml: test step 1: Docker action must use a sha256 digest: docker://alpine:3.20",
    ])
  })

  it("exits with an error from the command line", () => {
    const root = mkdtempSync(join(tmpdir(), "vitehub-ci-policy-"))
    try {
      mkdirSync(join(root, ".github/workflows"), { recursive: true })
      writeFileSync(join(root, ".github/workflows/ci.yml"), workflow("      - run: npx eslint .\n"))
      const result = spawnSync(process.execPath, [scriptPath, root], { encoding: "utf8" })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain("transient package executor must use an exact version: eslint")
    }
    finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
