import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  checkGitHubCIInputs,
  findGitHubCIPolicyFiles,
  inspectGitHubCIInputs,
} from "../.github/scripts/check-ci-inputs.mjs"

const repoRoot = resolve(import.meta.dirname, "..")
const scriptPath = resolve(repoRoot, ".github/scripts/check-ci-inputs.mjs")
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

describe("GitHub CI input policy", () => {
  it("parses every repository workflow and composite action", async () => {
    const files = await findGitHubCIPolicyFiles(repoRoot)

    expect(files.map(path => relative(repoRoot, path).replaceAll("\\", "/"))).toEqual([
      ".github/actions/setup-deno/action.yml",
      ".github/actions/setup/action.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/live-smoke.yml",
      ".github/workflows/pkg-pr-new.yml",
      ".github/workflows/pullfrog.yml",
      ".github/workflows/release.yml",
    ])
    await expect(checkGitHubCIInputs(repoRoot)).resolves.toEqual([])
  })

  it("allows full commit pins with version comments and local actions", async () => {
    const root = await createFixture({
      ".github/actions/setup/action.yaml": `runs:\n  using: composite\n  steps:\n    - uses: ${pinnedCheckout}\n`,
      ".github/workflows/ci.yaml": "jobs:\n  test:\n    steps:\n      - { uses: './.github/actions/setup' }\n",
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("allows pinned container images and transient package executors", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        `image: &pinned-image example/service@sha256:${"a".repeat(64)}`,
        "command: &pinned-command npx aliased@1.2.3",
        "env:",
        "  TOOL_VERSION: 1.2.3",
        "defaults:",
        "  run:",
        "    shell: npx --package=default-shell@1.2.3 -- bash {0}",
        "jobs:",
        "  test:",
        "    container:",
        `      image: example/service@sha256:${"a".repeat(64)}`,
        "    steps:",
        "      - run: npx first@1.2.3 && npx second@2.3.4",
        "      - run: pnpm --silent dlx tool@1.2.3 --help",
        "      - run: pnpm --dir . dlx tool@1.2.3 --help",
        "      - run: npm exec --package=tool@1.2.3 --package helper@2.3.4 -- tool",
        "      - run: npm --silent exec --package=tool@1.2.3 -- tool --package unpinned",
        "      - run: npx --package=tool@1.2.3 -- tool --package unpinned",
        "      - run: pnpx tool@1.2.3 --help",
        "      - run: corepack pnpm dlx tool@1.2.3 --help",
        "      - run: corepack pnpm@10.16.1 dlx tool@1.2.3 --help",
        "      - run: corepack pnpx tool@1.2.3 --help",
        "      - run: corepack yarn dlx tool@1.2.3 --help",
        "      - run: corepack yarnpkg@4.10.3 dlx tool@1.2.3 --help",
        "      - run: bun x tool@1.2.3 --help",
        "      - run: npm exec --package=runner@1.2.3 --call=\"npx nested@2.3.4\"",
        "      - run: npm exec -c 'echo ok'",
        "      - run: npm exec --allow-scripts lifecycle-helper tool@1.2.3",
        "      - run: env FOO=bar",
        "      - run: env -S 'npx tool@1.2.3'",
        "      - run: env -S '-u FOO npx tool@1.2.3'",
        "      - run: command npx tool@1.2.3",
        "      - run: command -v npx",
        "      - run: command -V pnpm",
        "      - run: command -pv npx unpinned",
        "      - run: command -pV pnpm unpinned",
        "      - run: nohup npx tool@1.2.3",
        "      - run: nohup -- npx tool@1.2.3",
        "      - run: nohup --help npx unpinned",
        "      - run: nohup --version npx unpinned",
        "      - run: sudo -l npx unpinned",
        "      - run: sudo --list npx unpinned",
        "      - run: sudo -ln npx unpinned",
        "      - run: sudo -nl npx unpinned",
        "      - run: exec -a tool npx tool@1.2.3",
        "      - run: 2>/dev/null npx redirected@1.2.3",
        "      - run: *pinned-command",
        "      - run: |",
        "          LOCAL_VERSION=1.2.3",
        "          npx local@$LOCAL_VERSION",
        "      - run: |",
        "          npx \\",
        "            tool@1.2.3",
        "      - run: npx \"tool@$TOOL_VERSION\" --help",
        "      - run: echo '$(npx unpinned)'",
        "      - run: echo npx unpinned",
        "      - run: echo ${FOO} npx unpinned",
        "      - run: echo \"$(printf ok)\" npx unpinned",
        "      - run: echo ok # npx unpinned",
        "      - run: echo pinned shell",
        "        shell: npx --package=shell@1.2.3 -- bash {0}",
        "  scalar:",
        "    container: *pinned-image",
        "    steps: []",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("allows Docker actions pinned to full SHA-256 digests", async () => {
    const digest = "1a".repeat(32)
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - uses: docker://alpine@sha256:${digest} # v3.22.1\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("rejects Docker actions that use movable tags", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: docker://alpine:3.22\n",
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("full SHA-256 digest") }),
    ])
  })

  it("ignores uses keys outside action invocation fields", async () => {
    const root = await createFixture({
      ".github/actions/setup/action.yml": `inputs:\n  uses:\n    description: Not an action reference\nruns:\n  using: composite\n  steps:\n    - uses: ${pinnedCheckout}\n`,
      ".github/workflows/ci.yml": `env:\n  uses: not-an-action-reference\njobs:\n  test:\n    env:\n      uses: still-not-an-action-reference\n    steps:\n      - uses: ${pinnedCheckout}\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("classifies Windows-style workflow paths", () => {
    const failures = inspectGitHubCIInputs(
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("classifies nested action manifests under .github/workflows as actions", async () => {
    const root = await createFixture({
      ".github/workflows/actions/setup/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v6\n",
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses: ./github/workflows/actions/setup\n",
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("does not share an enclosing sequence version comment across actions", async () => {
    const first = pinnedCheckout.split(" #")[0]
    const second = "actions/setup-node@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps: [{ uses: "${first}" }, { uses: "${second}" }] # v6.1.0\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining(first) }),
      expect.objectContaining({ message: expect.stringContaining(second) }),
    ])
  })

  it("allows a pinned reusable workflow with a flow-mapping version comment", async () => {
    const reference = "owner/repo/.github/workflows/build.yml@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  call: { uses: "${reference}" } # v1.2.3\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("allows a pinned reusable workflow with an enclosing jobs version comment", async () => {
    const reference = "owner/repo/.github/workflows/build.yml@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs: { call: { uses: "${reference}" } } # v1.2.3\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("does not share an enclosing jobs version comment across reusable workflows", async () => {
    const first = "owner/repo/.github/workflows/first.yml@1234567890abcdef1234567890abcdef12345678"
    const second = "owner/repo/.github/workflows/second.yml@abcdef1234567890abcdef1234567890abcdef12"
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs: { first: { uses: "${first}" }, second: { uses: "${second}" } } # v1.2.3\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("allows pinned steps with a flow-sequence version comment", async () => {
    const reference = pinnedCheckout.split(" #")[0]
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps: [{ uses: ${reference} }] # v6.1.0\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("actions/checkout@v6") }),
    ])
  })

  it("allows a pinned aliased reusable-workflow job with a version comment", async () => {
    const reference = "owner/repo/.github/workflows/build.yml@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": `job: &call\n  uses: ${reference}\njobs:\n  call: *call # v1.2.3\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("inspects action fields whose mapping keys are aliases", async () => {
    const root = await createFixture({
      ".github/actions/setup/action.yml": `inputs:\n  uses-key:\n    default: &uses-key uses\n  steps-key:\n    default: &steps-key steps\n  runs-key:\n    default: &runs-key runs\n? *runs-key\n:\n  using: composite\n  ? *steps-key\n  :\n    - ? *uses-key\n      : actions/checkout@v6\n`,
      ".github/workflows/ci.yml": `env:\n  JOBS_KEY: &jobs-key jobs\n  STEPS_KEY: &steps-key steps\n  USES_KEY: &uses-key uses\n? *jobs-key\n:\n  test:\n    ? *steps-key\n    :\n      - ? *uses-key\n        : actions/setup-node@v6\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
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

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ line: 4, message: expect.stringContaining(message), path: ".github/workflows/ci.yml" }),
    ])
  })

  it.each([
    "vp dlx wrangler deploy --dry-run",
    "pnpm dlx pkg-pr-new publish",
    "yarn dlx tool --help",
    "npx tool --help",
    "npx --package=tool -- tool",
    "bunx tool --help",
    "bun x tool --help",
    "pnpx tool --help",
    "corepack pnpm dlx tool --help",
    "corepack pnpm@10.16.1 dlx tool --help",
    "corepack pnpx tool --help",
    "corepack yarn dlx tool --help",
    "corepack yarnpkg@4.10.3 dlx tool --help",
    "corepack pnpm@latest dlx tool@1.2.3 --help",
    "npm exec -- tool --help",
    "vp dlx tool@latest --help",
    "npx pinned@1.2.3 && npx unpinned",
    "pnpm --silent dlx unpinned",
    "pnpm --dir . dlx unpinned",
    "npm x unpinned",
    "npm --silent exec unpinned",
    "npm --prefix . exec unpinned",
    "npm --user-agent custom exec unpinned",
    "npm exec --package=safe@1.2.3 --package=unpinned -- cmd",
    "npm exec --package=semver@7.7.2 -- npx unpinned",
    "npx --package=semver@7.7.2 -- npx unpinned",
    "npm exec --package=runner@1.2.3 -c 'npx unpinned'",
    "npm exec --package=runner@1.2.3 --call=\"npx unpinned\"",
    "version=$(npx unpinned --version)",
    "echo \"$(npx unpinned --version)\"",
    "echo \"$(npx unpinned $(echo foo))\"",
    'echo "`npx unpinned --version`"',
    "VERSION=latest npx tool@$VERSION",
    "npx tool@$UNRESOLVED_VERSION",
    "(npx unpinned)",
    "bash -c 'npx unpinned'",
    "bash -lc 'npx unpinned'",
    "bash -c -- 'npx unpinned'",
    "env FOO=bar npx unpinned",
    "env --ignore-environment -u FOO BAR=baz npx unpinned",
    "if true; then npx unpinned; fi",
    "while npx unpinned; do echo ok; done",
    'case "$x" in foo) npx unpinned ;; esac',
    "echo ok && { npx unpinned; }",
    "time -p npx unpinned",
    "echo ok & npx unpinned",
    "/usr/bin/npx unpinned",
    "$NVM_BIN/npx unpinned",
    "env -S \"npx unpinned\"",
    "env --split-string=\"npx unpinned\"",
    "env -S '-u FOO npx unpinned'",
    "env -S 'FOO=bar npx unpinned'",
    "command npx unpinned",
    "command -p -- npx unpinned",
    "2>/dev/null npx unpinned",
    "2>&1 npx unpinned",
    "2<&0 npx unpinned",
    "exec npx unpinned",
    "exec -a tool npx unpinned",
    "nohup npx unpinned",
    "nohup -- npx unpinned",
    "echo ${FOO:-$(npx unpinned)}",
    "sudo npx unpinned",
    "sudo -pl npx unpinned",
    "sudo -u root FOO=bar npx unpinned",
    "timeout 5m npx unpinned",
    "timeout --signal KILL 5m npx unpinned",
    "timeout --sig KILL 5m npx unpinned",
    "nice npx unpinned",
    "nice -n 5 npx unpinned",
    "nice --adjustment=5 npx unpinned",
    "nice -5 npx unpinned",
    "eval 'npx unpinned'",
    "eval -- 'npx unpinned'",
    "bash <<< 'npx unpinned'",
    "printf 'npx unpinned\\n' | bash",
    "printf '%s\\n' 'npx unpinned' | bash",
    "printf '%s\\n' 'echo safe' 'npx unpinned' | bash",
    "echo -e 'npx unpinned\\n' | bash",
    "echo -ne 'npx unpinned\\n' | bash",
    "printf '%c%s\\n' n 'px unpinned' | bash",
    String.raw`n\px unpinned`,
    "$'npx' unpinned",
    String.raw`$'n\x70x' unpinned`,
    '$"npx" unpinned',
  ])("rejects an unpinned package executor: %s", async (command) => {
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - run: ${command}\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("must use an exact version") }),
    ])
  })

  it("inspects composite actions whose runs map is aliased", async () => {
    const root = await createFixture({
      "action.yml": [
        "name: fixture",
        "description: fixture",
        "shared-runs: &shared-runs",
        "  using: composite",
        "  steps:",
        "    - run: npx unpinned",
        "      shell: bash",
        "runs: *shared-runs",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("unpinned") }),
    ])
  })

  it("tracks exact package versions assigned by export", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: |\n          export VERSION=1.2.3\n          npx tool@$VERSION\n",
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("applies exports in shell execution order", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: latest",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: npx tool@$VERSION && export VERSION=1.2.3",
        "      - run: export VERSION=1.2.3 && npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it("does not apply a later export to an earlier executor", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": "env:\n  VERSION: 1.2.3\njobs:\n  test:\n    steps:\n      - run: npx tool@$VERSION && export VERSION=latest\n",
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it.each(["false &&", "true ||"])("does not persist an export after %s", async (condition) => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: latest",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          " + condition + " export VERSION=1.2.3",
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it.each(["true &&", "false ||"])("applies an export after %s", async (condition) => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: 1.2.3",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          " + condition + " export VERSION=latest",
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it("does not trust a value after a conditional export", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: 1.2.3",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          command -v optional && export VERSION=latest",
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@(unresolved)") }),
    ])
  })

  it("does not trust an assignment from a conditional scope", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: 1.2.3",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          if true; then",
        "            VERSION=latest",
        "          fi",
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@(unresolved)") }),
    ])
  })

  it("does not trust an assignment after an inline branch keyword", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: 1.2.3",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: if true; then VERSION=latest; fi; npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@(unresolved)") }),
    ])
  })

  it("keeps subshell exports out of the parent environment", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: 1.2.3",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          (export VERSION=latest)",
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("tracks exact package versions in braced package words", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          VERSION=1.2.3",
        "          npx tool@${VERSION}",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("persists assignment-only commands before same-line separators", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": "env:\n  VERSION: 1.2.3\njobs:\n  test:\n    steps:\n      - run: VERSION=latest && npx tool@$VERSION\n",
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it("tracks assignment-only commands after ordinary same-line commands", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: VERSION=1.2.3; echo ok; VERSION=latest; npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it.each([
    ["an untaken conditional containing a substitution", ["if false; then", "echo $(true)", "VERSION=1.2.3", "fi"]],
    ["a zero-iteration for loop", ["for item in", "do", "VERSION=1.2.3", "done"]],
  ])("does not persist assignments from %s", async (_name, conditional) => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: latest",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        ...conditional.map(line => `          ${line}`),
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it("does not persist assignments from an uncalled function", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: latest",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          set_version() {",
        "            VERSION=1.2.3",
        "          }",
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it("does not persist assignments from a multiline uncalled function declaration", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: latest",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          set_version()",
        "          {",
        "            VERSION=1.2.3",
        "          }",
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it("preserves a pending function declaration across blank and comment lines", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  VERSION: latest",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          set_version()",
        "",
        "          # Keep the function body separate from its declaration.",
        "          {",
        "            VERSION=1.2.3",
        "          }",
        "          npx tool@$VERSION",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
    ])
  })

  it.each([
    "npm exec -w packages/foo tool@1.2.3",
    "npm exec --workspace packages/foo tool@1.2.3",
    "npx -w packages/foo tool@1.2.3",
  ])("allows a pinned workspace-scoped package executor: %s", async (command) => {
    const root = await createFixture({
      ".github/workflows/ci.yml": `jobs:\n  test:\n    steps:\n      - run: ${command}\n`,
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("inspects workflows whose complete jobs map is aliased", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "shared-jobs: &shared-jobs",
        "  test:",
        "    steps:",
        "      - run: npx unpinned",
        "jobs: *shared-jobs",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("unpinned") }),
    ])
  })

  it("preserves enclosing version comments on complete jobs aliases", async () => {
    const reference = "owner/repo/.github/workflows/build.yml@1234567890abcdef1234567890abcdef12345678"
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "shared-jobs: &shared-jobs",
        "  call:",
        `    uses: ${reference}`,
        "jobs: *shared-jobs # v1.2.3",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([])
  })

  it("ignores here-document data but inspects bodies executed by a shell", async () => {
    const dataRoot = await createFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          cat <<'EOF'",
        "          npx unpinned",
        "          EOF",
      ].join("\n"),
    })
    const shellRoot = await createFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          bash <<'EOF'",
        "          npx unpinned",
        "          EOF",
      ].join("\n"),
    })
    const pathShellRoot = await createFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          /bin/bash <<'EOF'",
        "          npx unpinned",
        "          EOF",
      ].join("\n"),
    })
    const pipedShellRoot = await createFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          cat <<'EOF' | bash",
        "          npx unpinned",
        "          EOF",
      ].join("\n"),
    })
    const expandingDataRoot = await createFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          cat <<EOF",
        "          npx is-just-data",
        "          $(npx unpinned)",
        "          EOF",
      ].join("\n"),
    })
    const punctuatedDelimiterRoot = await createFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          cat <<END-MARKER",
        "          npx is-just-data",
        "          END-MARKER",
        "          npx unpinned",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(dataRoot)).resolves.toEqual([])
    await expect(checkGitHubCIInputs(shellRoot)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("unpinned") }),
    ])
    await expect(checkGitHubCIInputs(pathShellRoot)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("unpinned") }),
    ])
    await expect(checkGitHubCIInputs(pipedShellRoot)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("unpinned") }),
    ])
    await expect(checkGitHubCIInputs(expandingDataRoot)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("unpinned") }),
    ])
    await expect(checkGitHubCIInputs(punctuatedDelimiterRoot)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("unpinned") }),
    ])
  })

  it("rejects mutable environment versions and custom shell executors", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "env:",
        "  TOOL_VERSION: latest",
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: npx tool@$TOOL_VERSION",
        "      - run: echo TOOL_VERSION=1.2.3 && npx tool@$TOOL_VERSION",
        "      - run: TOOL_VERSION=1.2.3 echo ok && npx tool@$TOOL_VERSION",
        "      - run: echo custom shell",
        "        shell: npx --package=shell -- bash {0}",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
      expect.objectContaining({ message: expect.stringContaining("tool@latest") }),
      expect.objectContaining({ message: expect.stringContaining("shell") }),
    ])
  })

  it("rejects transient executors in inherited default run shells", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "defaults:",
        "  run:",
        "    shell: npx --package=workflow-shell -- bash {0}",
        "jobs:",
        "  workflow-default:",
        "    steps:",
        "      - run: echo inherited",
        "  job-default:",
        "    defaults:",
        "      run:",
        "        shell: pnpx job-shell -- bash {0}",
        "    steps:",
        "      - run: echo overridden",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("workflow-shell") }),
      expect.objectContaining({ message: expect.stringContaining("job-shell") }),
    ])
  })

  it.each([
    "example/database",
    "example/database:latest",
    `example/database:latest@sha256:${"a".repeat(64)}`,
    "node:${{ matrix.tag }}",
  ])(
    "rejects a mutable container image: %s",
    async (image) => {
      const root = await createFixture({
        ".github/workflows/ci.yml": `jobs:\n  test:\n    services:\n      database:\n        image: ${image}\n`,
      })

      await expect(checkGitHubCIInputs(root)).resolves.toEqual([
        expect.objectContaining({ message: expect.stringContaining("must not use latest") }),
      ])
    },
  )

  it("rejects mutable scalar job containers through direct values and aliases", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "image: &mutable-image node",
        "jobs:",
        "  direct:",
        "    container: node",
        "    steps: []",
        "  alias:",
        "    container: *mutable-image",
        "    steps: []",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("must not use latest") }),
      expect.objectContaining({ message: expect.stringContaining("must not use latest") }),
    ])
  })

  it("rejects mutable service containers through an aliased services map", async () => {
    const root = await createFixture({
      ".github/workflows/ci.yml": [
        "shared-services: &shared-services",
        "  database:",
        "    image: example/database",
        "jobs:",
        "  test:",
        "    services: *shared-services",
        "    steps: []",
      ].join("\n"),
    })

    await expect(checkGitHubCIInputs(root)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("must not use latest") }),
    ])
  })

  it("rejects malformed YAML and non-string uses values", async () => {
    const malformedRoot = await createFixture({
      ".github/workflows/broken.yml": "jobs: [\n",
    })
    const nonStringRoot = await createFixture({
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - uses:\n          action: checkout\n",
    })

    await expect(checkGitHubCIInputs(malformedRoot)).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining("invalid YAML") }),
    ])
    await expect(checkGitHubCIInputs(nonStringRoot)).resolves.toEqual([
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
    expect(passing).toMatchObject({ status: 0, stderr: "", stdout: "GitHub CI inputs are pinned.\n" })

    const failing = spawnSync(process.execPath, [scriptPath, failingRoot], { encoding: "utf8" })
    expect(failing.status).toBe(1)
    expect(failing.stdout).toBe("")
    expect(failing.stderr).toContain(".github/workflows/ci.yml:4: external action must use a full 40-character commit SHA")

    const usageError = spawnSync(process.execPath, [scriptPath, passingRoot, failingRoot], { encoding: "utf8" })
    expect(usageError).toMatchObject({
      status: 2,
      stderr: "Usage: node .github/scripts/check-ci-inputs.mjs [repo-root]\n",
      stdout: "",
    })
  })
})
