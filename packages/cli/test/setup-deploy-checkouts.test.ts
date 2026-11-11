import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import process from "node:process"

import { describe, expect, it, vi } from "vitest"

import { builtProject, fakeHosts } from "./setup-deploy-helpers.ts"
import { operationRpcRequest, operationRpcResponse } from "./operation-rpc.ts"
import { isolateProjectPackages, runSetup } from "./setup-helpers.ts"

import type { ViteHubCliSpawn } from "@vite-hub/internal/cli"
import type { SetupDeployOutput, SetupError } from "../src/setup/index.ts"

type DeployJson = SetupDeployOutput & { error?: SetupError, rerun?: string }

/** The answer to the deploy question in a terminal. */
const terminal = vi.hoisted(() => ({ answer: "n" }))
vi.mock("node:readline/promises", () => ({ createInterface: () => ({ close: () => {}, question: async () => terminal.answer }) }))

const cloudflareEnv = { CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "cf-token-1" }
const remote = "https://docs.example.com"

/**
 * A small stand-in for `@vite-hub/workspace/checkout`, resolved from the project's node_modules as deploy resolves the
 * real one. The status reads `conflicts` of the lock. Pull writes the remote files and updates the lock. Push pulls
 * again, then commits with `workspace.commit`, both through the call that deploy passes.
 */
const fakeCheckoutModule = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const read = root => JSON.parse(readFileSync(join(root, "vitehub.lock"), "utf8"))
const fail = result => Object.assign(new Error(result.message), { code: result.code, fix: result.fix })

export async function localCheckoutStatus(root) {
  const lock = read(root)
  const names = Object.keys(lock.workspaces)
  if (!names.length) return undefined
  return names.map(workspace => ({ workspace, dir: lock.workspaces[workspace].dir, local: { added: [], modified: [], deleted: [], conflicted: lock.workspaces[workspace].conflicts ?? [] } }))
}

async function pullEntry(call, rootDir, workspace, entry) {
  const changes = await call("workspace.changes", { workspace, ref: entry.ref, since: entry.head }, entry.remote)
  if (!changes.ok) throw fail(changes)
  const pull = { workspace, ref: entry.ref, from: entry.head, head: changes.value.head, files: [] }
  for (const file of changes.value.files) {
    const target = join(rootDir, entry.dir, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content)
    pull.files.push({ path: file.path, action: "added" })
  }
  entry.head = changes.value.head
  if (changes.value.conflicts) entry.conflicts = changes.value.conflicts
  return pull
}

export async function pullWorkspaces({ call, rootDir }) {
  const lock = read(rootDir)
  const results = []
  try {
    for (const [workspace, entry] of Object.entries(lock.workspaces)) results.push(await pullEntry(call, rootDir, workspace, entry))
  }
  finally {
    writeFileSync(join(rootDir, "vitehub.lock"), JSON.stringify(lock))
  }
  return results
}

export async function pushWorkspaces({ call, rootDir }) {
  const lock = read(rootDir)
  const results = []
  try {
    for (const [workspace, entry] of Object.entries(lock.workspaces)) {
      const pull = await pullEntry(call, rootDir, workspace, entry)
      const commit = await call("workspace.commit", { workspace, ref: entry.ref, ifHead: entry.head }, entry.remote)
      if (!commit.ok) throw fail(commit)
      if (!commit.value.revision) {
        results.push({ workspace, ref: entry.ref, pushed: [], pull })
        continue
      }
      const result = { workspace, ref: entry.ref, revision: commit.value.revision.id, pushed: ["guide.md"], pull }
      if (entry.head === null && commit.value.revision.parentId !== null) {
        const changes = await call("workspace.changes", { workspace, ref: entry.ref, since: entry.head }, entry.remote)
        if (!changes.ok) throw fail(changes)
        result.after = { workspace, ref: entry.ref, from: entry.head, head: changes.value.head, files: [] }
        for (const file of changes.value.files) {
          const target = join(rootDir, entry.dir, file.path)
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, file.content)
          result.after.files.push({ path: file.path, action: "added" })
        }
      }
      entry.head = commit.value.revision.id
      results.push(result)
    }
  }
  finally {
    writeFileSync(join(rootDir, "vitehub.lock"), JSON.stringify(lock))
  }
  return results
}
`

const checkoutPackage = {
  "node_modules/@vite-hub/workspace/checkout.js": fakeCheckoutModule,
  "node_modules/@vite-hub/workspace/package.json": JSON.stringify({ exports: { "./checkout": "./checkout.js" }, name: "@vite-hub/workspace", type: "module" }),
}

/** The fake checkout module, which also writes `imported` next to itself when it loads. */
const markedCheckoutPackage = {
  ...checkoutPackage,
  "node_modules/@vite-hub/workspace/checkout.js": `import { writeFileSync as mark } from "node:fs"\nmark(new URL("./imported", import.meta.url), "")\n${fakeCheckoutModule}`,
}
const importMarker = (root: string) => join(root, "node_modules/@vite-hub/workspace/imported")

/** Runs `fn` as if stdin and stderr were a terminal, so deploy asks its question. */
async function inTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const before = { stderr: process.stderr.isTTY, stdin: process.stdin.isTTY }
  process.stdin.isTTY = true
  process.stderr.isTTY = true
  try {
    return await fn()
  }
  finally {
    process.stdin.isTTY = before.stdin
    process.stderr.isTTY = before.stderr
  }
}

function lock(entry: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, workspaces: { docs: { dir: "content", files: {}, head: "r1", ref: "main", remote, ...entry } } })
}

interface Workspace {
  /** What the fake app answers to `workspace.changes`. */
  changes?: { head: string | null, files: Array<{ path: string, content: string }>, conflicts?: string[] }
  /** Files inherited by a new ref, pulled after its first commit. */
  after?: Workspace["changes"]
  /** What the fake app answers to `workspace.commit`. */
  commit?: { ok: true, value: { revision?: { id: string, parentId?: string | null } } } | { ok: false, code: string, message: string, fix?: string }
}

/** A fake deployed app that serves the Workspace operations, and records each request with the host calls before it. */
function workspaceApp(hosts: Awaited<ReturnType<typeof fakeHosts>>, workspace: Workspace = {}) {
  const requests: Array<{ url: string, operation: string, hostCallsBefore: number }> = []
  let committed = false
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const body = operationRpcRequest(init?.body) as { operation: string, input: { since?: string | null } }
    requests.push({ hostCallsBefore: (await hosts.calls()).length, operation: body.operation, url })
    if (!url.startsWith(remote)) throw new Error(`unexpected request to ${url}`)
    const changes = (committed ? workspace.after : undefined) ?? workspace.changes ?? { files: [], head: "r1" }
    const answer = body.operation === "workspace.changes"
      ? { ok: true as const, value: { ...changes, files: body.input.since === changes.head ? [] : changes.files } }
      : workspace.commit ?? { ok: true as const, value: { revision: { id: "r3" } } }
    if (body.operation === "workspace.commit" && answer.ok) committed = true
    return operationRpcResponse(init?.body, answer.ok ? answer : { ...answer, status: 409 })
  }
  return { fetch, requests }
}

async function readLock(root: string): Promise<{ workspaces: Record<string, { head: string }> }> {
  return JSON.parse(await readFile(join(root, "vitehub.lock"), "utf8")) as { workspaces: Record<string, { head: string }> }
}

describe("vitehub deploy with checkout folders in vitehub.lock", () => {
  it("builds pulled files, then pushes to the lock remote after the deploy and lists the files to commit", async () => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "content/guide.md": "# Guide\n", "vitehub.lock": lock() })
    const hosts = await fakeHosts(cloudflareEnv)
    const app = workspaceApp(hosts, { changes: { files: [{ content: "# News\n", path: "news.md" }], head: "r2" } })
    const built: string[] = []
    const spawn: ViteHubCliSpawn = async () => {
      built.push(await readFile(join(root, "content/news.md"), "utf8"))
      expect(await hosts.calls()).toEqual([])
      expect(app.requests.map(request => request.operation)).toEqual(["workspace.changes"])
      return { exitCode: 0 }
    }
    const result = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, { fetch: app.fetch, spawn })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(built).toEqual(["# News\n"])
    expect(result.json).toMatchObject({ host: "cloudflare", url: "https://my-app.example.workers.dev" })
    expect(result.json.checkouts).toEqual({
      changed: ["vitehub.lock", "content/news.md"],
      results: [{ pull: { files: [{ action: "added", path: "news.md" }], from: "r1", head: "r2", ref: "main", workspace: "docs" }, pushed: ["guide.md"], ref: "main", revision: "r3", workspace: "docs" }],
    })
    // The push runs after the host deploy, against the remote that the lock names.
    expect(app.requests.map(request => request.operation)).toEqual(["workspace.changes", "workspace.changes", "workspace.commit"])
    expect(app.requests[0]!.hostCallsBefore).toBe(0)
    const deployCalls = (await hosts.calls()).length
    expect(deployCalls).toBeGreaterThan(0)
    for (const request of app.requests.slice(1)) {
      expect(request.hostCallsBefore).toBe(deployCalls)
      expect(new URL(request.url).origin).toBe(remote)
    }
    expect((await readLock(root)).workspaces.docs!.head).toBe("r3")
    expect(await readFile(join(root, "content/news.md"), "utf8")).toBe("# News\n")
  })

  it.each([false, true])("reports files inherited after the first push (json: %s)", async (json) => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "content/guide.md": "# Guide\n", "vitehub.lock": lock({ head: null }) })
    const hosts = await fakeHosts(cloudflareEnv)
    const app = workspaceApp(hosts, {
      after: { files: [{ content: "# Inherited\n", path: "inherited.md" }], head: "r3" },
      changes: { files: [], head: null },
      commit: { ok: true, value: { revision: { id: "r3", parentId: "default-head" } } },
    })
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--yes", ...(json ? ["--json"] : [])], root, hosts.env, { fetch: app.fetch })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(app.requests.map(request => request.operation)).toEqual(["workspace.changes", "workspace.changes", "workspace.commit", "workspace.changes"])
    expect(await readFile(join(root, "content/inherited.md"), "utf8")).toBe("# Inherited\n")
    if (json) {
      expect(result.json.checkouts).toMatchObject({
        changed: ["vitehub.lock", "content/inherited.md"],
        results: [{ after: { files: [{ action: "added", path: "inherited.md" }], from: null, head: "r3", ref: "main" } }],
      })
    }
    else {
      expect(result.stdout).toContain("docs: pulled main (empty) -> r3\n  added    inherited.md\n")
      expect(result.stdout).toContain("The push changed these files. Commit them:\n  vitehub.lock\n  content/inherited.md\n")
    }
  })

  it("prints the push like `vitehub push` after the deploy line", async () => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "vitehub.lock": lock() })
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await runSetup(["deploy", "--no-build", "--yes"], root, hosts.env, { fetch: workspaceApp(hosts).fetch })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toBe([
      "Deployed my-app to cloudflare: https://my-app.example.workers.dev",
      "Version: version-1",
      "docs: pushed 1 file to main (r3)",
      "  guide.md",
      "The push changed these files. Commit them:",
      "  vitehub.lock",
      "",
    ].join("\n"))
  })

  it("does not ask to commit when nothing changed", async () => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "vitehub.lock": lock() })
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await runSetup(["deploy", "--no-build", "--yes"], root, hosts.env, { fetch: workspaceApp(hosts, { commit: { ok: true, value: {} } }).fetch })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain("docs: nothing to push.\n")
    expect(result.stdout).not.toContain("Commit them")
  })

  it("exits 1 before the build when a checkout has unresolved conflicts", async () => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "vitehub.lock": lock({ conflicts: ["guide.md", "logo.png"] }) })
    const hosts = await fakeHosts(cloudflareEnv)
    const app = workspaceApp(hosts)
    const spawned: string[] = []
    const spawn: ViteHubCliSpawn = async (command) => {
      spawned.push(command)
      return { exitCode: 0 }
    }
    const result = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, { fetch: app.fetch, spawn })

    expect(result.exitCode, result.stdout + result.stderr).toBe(1)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_CHECKOUT_CONFLICT")
    expect(result.json.error?.why).toContain("content/guide.md, content/logo.png")
    expect(spawned).toEqual([])
    expect(await hosts.calls()).toEqual([])
    expect(app.requests).toEqual([])
  })

  it("stops before the build when the pre-build pull creates a conflict", async () => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "vitehub.lock": lock() })
    const hosts = await fakeHosts(cloudflareEnv)
    const app = workspaceApp(hosts, { changes: { conflicts: ["guide.md", "logo.png"], files: [], head: "r2" } })
    const spawn = vi.fn<ViteHubCliSpawn>(async () => ({ exitCode: 0 }))
    const result = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, { fetch: app.fetch, spawn })

    expect(result.exitCode, result.stdout + result.stderr).toBe(1)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_CHECKOUT_CONFLICT")
    expect(result.json.error?.why).toContain("content/guide.md, content/logo.png")
    expect(spawn).not.toHaveBeenCalled()
    expect(await hosts.calls()).toEqual([])
    expect(app.requests.map(request => request.operation)).toEqual(["workspace.changes"])
  })

  it("exits 1 after the deploy when the push fails, and says to run `vitehub push`", async () => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "vitehub.lock": lock() })
    const hosts = await fakeHosts(cloudflareEnv)
    const commit = { code: "WORKSPACE_FORBIDDEN", fix: "Set VITEHUB_CONSOLE_TOKEN.", message: "The token cannot write docs.", ok: false } as const
    const app = workspaceApp(hosts, { commit })
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--yes", "--json"], root, hosts.env, { fetch: app.fetch })

    expect(result.exitCode, result.stdout + result.stderr).toBe(1)
    expect((await hosts.calls()).some(call => call.argv[0] === "deploy")).toBe(true)
    expect(result.json).toMatchObject({
      checkouts: { error: { code: "WORKSPACE_FORBIDDEN", fix: "Set VITEHUB_CONSOLE_TOKEN.", message: "The token cannot write docs." } },
      error: { code: "SETUP_DEPLOY_PUSH_FAILED" },
      host: "cloudflare",
      rerun: "vitehub push",
      url: "https://my-app.example.workers.dev",
    })
    expect(result.json.error?.why).toBe("The app is deployed to https://my-app.example.workers.dev, but the Workspace push failed: WORKSPACE_FORBIDDEN: The token cannot write docs.")
    expect(result.json.error?.fix).toBe("Set VITEHUB_CONSOLE_TOKEN. Then run `vitehub push`. Do not deploy again.")

    const text = await runSetup(["deploy", "--no-build", "--yes"], root, hosts.env, { fetch: app.fetch })
    expect(text.exitCode).toBe(1)
    expect(text.stdout).toContain("Deployed my-app to cloudflare: https://my-app.example.workers.dev\n")
    expect(text.stderr).toContain("The app is deployed to https://my-app.example.workers.dev, but the Workspace push failed")
    expect(text.stderr).toContain("Run: vitehub push\n")
  })

  it.each([["--no-push"], ["--preview"], ["--preview", "--no-push"]])("skips the conflict check and the push with %s", async (...flags) => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "vitehub.lock": lock({ conflicts: ["guide.md"] }) })
    const before = await readFile(join(root, "vitehub.lock"), "utf8")
    const hosts = await fakeHosts(cloudflareEnv)
    const app = workspaceApp(hosts)
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--yes", "--json", ...flags], root, hosts.env, { fetch: app.fetch })

    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.json.checkouts).toBeUndefined()
    expect(app.requests).toEqual([])
    expect(await readFile(join(root, "vitehub.lock"), "utf8")).toBe(before)
  })

  it("deploys as before without a lock, without a checkout, or without the Workspace package", async () => {
    const warning = "[vitehub] vitehub.lock has checkout folders, but the deploy does not push them because the Workspace package is not installed. Install @vite-hub/workspace or vite-hub.\n"
    const projects = {
      "an empty lock": { files: { ...checkoutPackage, "vitehub.lock": JSON.stringify({ version: 1, workspaces: {} }) }, stderr: "" },
      "no lock": { files: checkoutPackage, stderr: "" },
      "no Workspace package": { files: { "vitehub.lock": lock({ conflicts: ["guide.md"] }) }, stderr: warning },
      "a Workspace package without ./checkout": {
        files: { "node_modules/@vite-hub/workspace/package.json": JSON.stringify({ exports: { ".": "./index.js" }, name: "@vite-hub/workspace", type: "module" }), "vitehub.lock": lock() },
        stderr: warning,
      },
      "no Workspace package and an empty lock": { files: { "vitehub.lock": JSON.stringify({ version: 1, workspaces: {} }) }, stderr: "" },
    }
    for (const [name, project] of Object.entries(projects)) {
      const root = await builtProject("cloudflare", project.files)
      isolateProjectPackages(root)
      const hosts = await fakeHosts(cloudflareEnv)
      const app = workspaceApp(hosts)
      const result = await runSetup<DeployJson>(["deploy", "--no-build", "--yes", "--json"], root, hosts.env, { fetch: app.fetch })
      expect(result.exitCode, `${name}: ${result.stdout}${result.stderr}`).toBe(0)
      expect(result.json, name).toEqual({ host: "cloudflare", schemaVersion: 1, url: "https://my-app.example.workers.dev", version: "version-1" })
      expect(result.stderr.split("\n").filter(line => line.startsWith("[vitehub] vitehub.lock")).map(line => `${line}\n`).join(""), name).toBe(project.stderr)
      expect(app.requests, name).toEqual([])
    }
  })

  it.each([
    ["a syntax error", "export const = 1\n", "SyntaxError"],
    ["a missing dependency", "import \"vitehub-missing-dependency\"\nexport const localCheckoutStatus = () => undefined\n", "vitehub-missing-dependency"],
    ["an error when it loads", "throw new Error(\"checkout init failed\")\n", "checkout init failed"],
    ["no checkout functions", "export const other = 1\n", "does not export localCheckoutStatus, pullWorkspaces and pushWorkspaces"],
    ["no pull function", "export const localCheckoutStatus = () => []\nexport const pushWorkspaces = () => []\n", "does not export localCheckoutStatus, pullWorkspaces and pushWorkspaces"],
  ])("exits 1 before the build when the installed checkout module has %s", async (_name, source, message) => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "node_modules/@vite-hub/workspace/checkout.js": source, "vitehub.lock": lock() })
    const hosts = await fakeHosts(cloudflareEnv)
    const app = workspaceApp(hosts)
    const spawned: string[] = []
    const spawn: ViteHubCliSpawn = async (command) => {
      spawned.push(command)
      return { exitCode: 0 }
    }
    const result = await runSetup<DeployJson>(["deploy", "--yes", "--json"], root, hosts.env, { fetch: app.fetch, spawn })

    expect(result.exitCode, result.stdout + result.stderr).toBe(1)
    expect(result.json.error?.code).toBe("SETUP_DEPLOY_CHECKOUT_MODULE_FAILED")
    expect(result.json.error?.why).toContain(join(root, "node_modules/@vite-hub/workspace/checkout.js"))
    expect(result.json.error?.why).toContain(message)
    expect(spawned).toEqual([])
    expect(await hosts.calls()).toEqual([])
    expect(app.requests).toEqual([])
  })

  it("does not load the checkout module when vitehub.lock has no checkout folder", async () => {
    const broken = { ...checkoutPackage, "node_modules/@vite-hub/workspace/checkout.js": "throw new Error(\"checkout init failed\")\n" }
    const locks = {
      "an empty lock": JSON.stringify({ version: 1, workspaces: {} }),
      "a lock without workspaces": JSON.stringify({ version: 1 }),
      "no lock": undefined,
    }
    for (const [name, source] of Object.entries(locks)) {
      const root = await builtProject("cloudflare", { ...broken, ...(source === undefined ? {} : { "vitehub.lock": source }) })
      const hosts = await fakeHosts(cloudflareEnv)
      const result = await runSetup<DeployJson>(["deploy", "--no-build", "--yes", "--json"], root, hosts.env)
      expect(result.exitCode, `${name}: ${result.stdout}${result.stderr}`).toBe(0)
      expect(result.json.url, name).toBe("https://my-app.example.workers.dev")
    }
  })

  it("does not load the checkout module when the deploy is not confirmed", async () => {
    const root = await builtProject("cloudflare", { ...markedCheckoutPackage, "vitehub.lock": lock() })
    const hosts = await fakeHosts(cloudflareEnv)

    const noTerminal = await runSetup<DeployJson>(["deploy", "--no-build", "--json"], root, hosts.env)
    expect(noTerminal.exitCode).toBe(2)
    expect(existsSync(importMarker(root))).toBe(false)

    terminal.answer = "n"
    const declined = await inTerminal(async () => await runSetup(["deploy", "--no-build"], root, hosts.env))
    expect(declined.exitCode, declined.stderr).toBe(1)
    expect(declined.stderr).toContain("The deploy was not confirmed.")
    expect(existsSync(importMarker(root))).toBe(false)
    expect(await hosts.calls()).toEqual([])

    terminal.answer = "y"
    const app = workspaceApp(hosts)
    const confirmed = await inTerminal(async () => await runSetup(["deploy", "--no-build"], root, hosts.env, { fetch: app.fetch }))
    expect(confirmed.exitCode, confirmed.stderr).toBe(0)
    expect(existsSync(importMarker(root))).toBe(true)
    expect(app.requests.map(request => request.operation)).toEqual(["workspace.changes", "workspace.changes", "workspace.commit"])
  })

  it("keeps --no-push in the rerun and documents it in --help", async () => {
    const root = await builtProject("cloudflare", { ...checkoutPackage, "vitehub.lock": lock() })
    const hosts = await fakeHosts(cloudflareEnv)
    const result = await runSetup<DeployJson>(["deploy", "--no-build", "--no-push", "--json"], root, hosts.env)
    expect(result.exitCode).toBe(2)
    expect(result.json.rerun).toBe("vitehub deploy --no-build --no-push --yes --json")

    const help = await runSetup(["deploy", "--help"], root)
    expect(help.stdout).toContain("[--no-push]")
    expect(help.stdout).toContain("A --preview deploy does not push")
  })
})
