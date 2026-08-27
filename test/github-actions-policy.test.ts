import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  checkGitHubActionPins,
  findGitHubActionPolicyFiles,
  inspectGitHubActionReferences,
} from "../.github/scripts/check-action-pins.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const scriptPath = resolve(repoRoot, ".github/scripts/check-action-pins.mjs")
const pinnedCheckout = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0"
const temporaryDirectories: string[] = []

async function createFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-action-policy-"))
  temporaryDirectories.push(root)
  for (const [path, source] of Object.entries(files)) {
    const destination = resolve(root, path)
    await mkdir(resolve(destination, ".."), { recursive: true })
    await writeFile(destination, source)
  }
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe("GitHub Action pin policy", () => {
  it("parses every repository workflow and composite action", async () => {
    const files = await findGitHubActionPolicyFiles(repoRoot)

    expect(files.map(path => path.replace(`${repoRoot}/`, ""))).toEqual([
      ".github/actions/setup-deno/action.yml",
      ".github/actions/setup/action.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/live-smoke.yml",
      ".github/workflows/pkg-pr-new.yml",
      ".github/workflows/pullfrog.yml",
      ".github/workflows/release.yml",
    ])
    await expect(checkGitHubActionPins(repoRoot)).resolves.toEqual([])
  })

  it("allows full commit pins with version comments and local actions", async () => {
    const root = await createFixture({
      ".github/actions/setup/action.yaml": `runs:\n  using: composite\n  steps:\n    - uses: ${pinnedCheckout}\n`,
      ".github/workflows/ci.yaml": "jobs:\n  test:\n    steps:\n      - { uses: './.github/actions/setup' }\n",
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("ignores uses keys outside action invocation fields", async () => {
    const root = await createFixture({
      ".github/actions/setup/action.yml": `inputs:\n  uses:\n    description: Not an action reference\nruns:\n  using: composite\n  steps:\n    - uses: ${pinnedCheckout}\n`,
      ".github/workflows/ci.yml": `env:\n  uses: not-an-action-reference\njobs:\n  test:\n    env:\n      uses: still-not-an-action-reference\n    steps:\n      - uses: ${pinnedCheckout}\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("classifies Windows-style workflow paths", () => {
    const failures = inspectGitHubActionReferences(
      ".github\\workflows\\ci.yml",
      "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v6\n",
    )

    expect(failures).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("full 40-character commit SHA"),
        path: ".github\\workflows\\ci.yml",
      }),
    ])
  })

  it("finds composite actions outside .github/actions", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": "steps:\n  - uses: ./tools/setup\n",
      "tools/setup/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v6\n",
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({
        message: expect.stringContaining("full 40-character commit SHA"),
        path: "tools/setup/action.yml",
      }),
    ])
  })

  it("follows symlinked composite action manifests", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": "steps:\n  - uses: ./tools/setup\n",
      "tools/setup/composite.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v6\n",
    })
    await symlink("composite.yml", resolve(root, "tools/setup/action.yml"))

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({
        message: expect.stringContaining("full 40-character commit SHA"),
        path: "tools/setup/action.yml",
      }),
    ])
  })

  it("allows a pinned action with a flow-mapping version comment", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - { uses: "${pinnedCheckout.split(" #")[0]}" } # v6.1.0\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it.each([
    ["movable tag", "actions/checkout@v6 # v6.1.0", "full 40-character commit SHA"],
    ["missing version comment", pinnedCheckout.split(" #")[0], "exact version comment"],
    ["branch reference in a flow mapping", "actions/checkout@main", "full 40-character commit SHA"],
  ])("rejects a %s", async (_name, reference, message) => {
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - { uses: "${reference}" }\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({ line: 4, message: expect.stringContaining(message), path: ".github/workflows/ci.yml" }),
    ])
  })

  it("rejects malformed YAML and non-string uses values", async () => {
    const malformedRoot = await createFixture({
      ".github/workflows/broken.yml": "jobs: [\n",
    })
    const nonStringRoot = await createFixture({
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses:\n          action: checkout\n",
    })

    await expect(checkGitHubActionPins(malformedRoot)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("invalid YAML") }),
    ])
    await expect(checkGitHubActionPins(nonStringRoot)).resolves.toEqual([
      expect.objectContaining({ message: "uses must be a string" }),
    ])
  })

  it("has stable success, policy failure, and usage-error CLI contracts", async () => {
    const passingRoot = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - uses: ${pinnedCheckout}\n`,
    })
    const failingRoot = await createFixture({
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v6\n",
    })

    const passing = spawnSync(process.execPath, [scriptPath, passingRoot], { encoding: "utf8" })
    expect(passing).toMatchObject({ status: 0, stderr: "", stdout: "GitHub Action references are pinned.\n" })

    const failing = spawnSync(process.execPath, [scriptPath, failingRoot], { encoding: "utf8" })
    expect(failing.status).toBe(1)
    expect(failing.stdout).toBe("")
    expect(failing.stderr).toContain(".github/workflows/ci.yml:4: external action must use a full 40-character commit SHA")

    const usageError = spawnSync(process.execPath, [scriptPath, passingRoot, failingRoot], { encoding: "utf8" })
    expect(usageError).toMatchObject({
      status: 2,
      stderr: "Usage: node .github/scripts/check-action-pins.mjs [repo-root]\n",
      stdout: "",
    })
  })
})
