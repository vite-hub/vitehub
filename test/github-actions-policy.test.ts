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

  it("ignores nested YAML files that GitHub does not discover as workflows", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - uses: ${pinnedCheckout}\n`,
      ".github/workflows/fixtures/example.yml": "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v6\n",
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("classifies nested action manifests under .github/workflows as actions", async () => {
    const root = await createFixture({
      ".github/workflows/actions/setup/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v6\n",
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: ./github/workflows/actions/setup\n",
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({
        message: expect.stringContaining("full 40-character commit SHA"),
        path: ".github/workflows/actions/setup/action.yml",
      }),
    ])
  })

  it("classifies a direct workflow named action.yml as a workflow", async () => {
    const root = await createFixture({
      ".github/workflows/action.yml": "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v6\n",
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({
        message: expect.stringContaining("full 40-character commit SHA"),
        path: ".github/workflows/action.yml",
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

  it("does not share an enclosing sequence version comment across actions", async () => {
    const first = pinnedCheckout.split(" #")[0]
    const second = "actions/setup-node@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps: [{ uses: "${first}" }, { uses: "${second}" }] # v6.1.0\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining(first) }),
      expect.objectContaining({ message: expect.stringContaining(second) }),
    ])
  })

  it("allows a pinned reusable workflow with a flow-mapping version comment", async () => {
    const reference = "owner/repo/.github/workflows/build.yml@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  call: { uses: "${reference}" } # v1.2.3\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("allows a pinned reusable workflow with an enclosing jobs version comment", async () => {
    const reference = "owner/repo/.github/workflows/build.yml@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs: { call: { uses: "${reference}" } } # v1.2.3\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("does not share an enclosing jobs version comment across reusable workflows", async () => {
    const first = "owner/repo/.github/workflows/first.yml@1234567890abcdef1234567890abcdef12345678"
    const second = "owner/repo/.github/workflows/second.yml@abcdef1234567890abcdef1234567890abcdef12"
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs: { first: { uses: "${first}" }, second: { uses: "${second}" } } # v1.2.3\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining(first) }),
      expect.objectContaining({ message: expect.stringContaining(second) }),
    ])
  })

  it("allows pinned action references through YAML aliases", async () => {
    const reference = pinnedCheckout.split(" #")[0]
    const root = await createFixture({
      ".github/actions/setup/action.yml": `inputs:\n  checkout:\n    default: &checkout ${reference}\nruns:\n  using: composite\n  steps:\n    - uses: *checkout # v6.1.0\n`,
      ".github/workflows/ci.yml": `env:\n  CHECKOUT: &checkout ${reference}\njobs:\n  test:\n    steps:\n      - uses: *checkout # v6.1.0\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("inspects action references through aliased step containers and steps", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": `step: &unpinned-step
  uses: actions/checkout@v6
steps: &unpinned-steps
  - uses: actions/setup-node@v6
jobs:
  container-alias:
    steps: *unpinned-steps
  step-alias:
    steps:
      - *unpinned-step
`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("actions/setup-node@v6") }),
      expect.objectContaining({ message: expect.stringContaining("actions/checkout@v6") }),
    ])
  })

  it("allows a pinned aliased step with a version comment", async () => {
    const reference = pinnedCheckout.split(" #")[0]
    const root = await createFixture({
      ".github/workflows/ci.yml": `step: &checkout
  uses: ${reference}
jobs:
  test:
    steps:
      - *checkout # v6.1.0
`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("allows pinned steps with a flow-sequence version comment", async () => {
    const reference = pinnedCheckout.split(" #")[0]
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps: [{ uses: ${reference} }] # v6.1.0\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("inspects action references through aliased workflow jobs", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": `job: &unpinned-job
  steps:
    - uses: actions/checkout@v6
jobs:
  test: *unpinned-job
`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("actions/checkout@v6") }),
    ])
  })

  it("allows a pinned aliased reusable-workflow job with a version comment", async () => {
    const reference = "owner/repo/.github/workflows/build.yml@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": `job: &call\n  uses: ${reference}\njobs:\n  call: *call # v1.2.3\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([])
  })

  it("inspects action fields whose mapping keys are aliases", async () => {
    const root = await createFixture({
      ".github/actions/setup/action.yml": `inputs:\n  uses-key:\n    default: &uses-key uses\n  steps-key:\n    default: &steps-key steps\n  runs-key:\n    default: &runs-key runs\n? *runs-key\n:\n  using: composite\n  ? *steps-key\n  :\n    - ? *uses-key\n      : actions/checkout@v6\n`,
      ".github/workflows/ci.yml": `env:\n  JOBS_KEY: &jobs-key jobs\n  STEPS_KEY: &steps-key steps\n  USES_KEY: &uses-key uses\n? *jobs-key\n:\n  test:\n    ? *steps-key\n    :\n      - ? *uses-key\n        : actions/setup-node@v6\n`,
    })

    await expect(checkGitHubActionPins(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("actions/checkout@v6") }),
      expect.objectContaining({ message: expect.stringContaining("actions/setup-node@v6") }),
    ])
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
