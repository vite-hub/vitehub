import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const script = resolve(import.meta.dirname, "../scripts/consumer-check.mjs")
const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_AUTHOR_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
}

let root = ""
let repo = ""
let base = ""
let head = ""

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvironment, stdio: "pipe" }).trim()
}

function commitAll(cwd: string, message: string) {
  git(cwd, "add", "-A")
  git(cwd, "commit", "-q", "-m", message)
  return git(cwd, "rev-parse", "HEAD")
}

function consumer(name: string, files: Record<string, string>) {
  const path = join(root, name)
  for (const [file, contents] of Object.entries(files)) write(join(path, file), contents)
  return path
}

function check(environment: Record<string, string>, ...args: string[]) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEHUB_CONSUMER_ROOTS")))
  return spawnSync(process.execPath, [script, "--base", base, "--head", head, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...inherited, HOME: join(root, "home"), ...environment },
  })
}

const roots = (...paths: string[]) => ({ VITEHUB_CONSUMER_ROOTS: paths.join(delimiter) })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "vitehub-consumer-check-"))
  repo = join(root, "repo")
  mkdirSync(join(root, "home"))
  git(root, "init", "-q", repo)

  const demoExports = {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./extra": { types: "./dist/extra.d.ts", import: "./dist/extra.js" },
  }
  write(join(repo, "packages/demo/package.json"), JSON.stringify({ name: "@vite-hub/demo", exports: demoExports }))
  write(join(repo, "packages/demo/src/index.ts"), "export function keep() {}\nexport function dropped() {}\nexport * from \"./more.ts\"\n")
  write(join(repo, "packages/demo/src/more.ts"), "export const starDropped = 1\nexport type Kept = string\n")
  write(join(repo, "packages/demo/src/extra.ts"), "export const extra = 1\n")
  write(join(repo, "packages/vite-hub/package.json"), JSON.stringify({
    name: "vite-hub",
    exports: { "./demo": { import: "./dist/demo.js" }, "./demo/extra": { import: "./dist/demo/extra.js" } },
  }))
  write(join(repo, "packages/vite-hub/src/demo.ts"), "export * from \"@vite-hub/demo\"\n")
  write(join(repo, "packages/vite-hub/src/demo/extra.ts"), "export * from \"@vite-hub/demo/extra\"\n")
  base = commitAll(repo, "base")

  write(join(repo, "packages/demo/package.json"), JSON.stringify({ name: "@vite-hub/demo", exports: { ".": demoExports["."] } }))
  write(join(repo, "packages/demo/src/index.ts"), "export function keep() {}\nexport * from \"./more.ts\"\n")
  write(join(repo, "packages/demo/src/more.ts"), "export type Kept = string\n")
  rmSync(join(repo, "packages/demo/src/extra.ts"))
  head = commitAll(repo, "head")

  consumer("clean-app", {
    "src/app.ts": "import { keep } from \"@vite-hub/demo\"\nconst droppedLater = keep()\nimport \"@vite-hub/demo/extra-styles\"\n",
  })
  consumer("used-app", {
    "src/auth.ts": "import { dropped } from \"@vite-hub/demo\"\n",
    "node_modules/@vite-hub/demo/index.js": "export function dropped() {}\n",
    "dist/server.js": "dropped()\n",
  })
  consumer("patched-app", {
    "patches/vite-hub.patch": "+export * from \"vite-hub/demo/extra\"\n",
  })
  const branchApp = consumer("branch-app", { "server/use.ts": "import { starDropped } from \"vite-hub/demo\"\n" })
  git(root, "init", "-q", branchApp)
  commitAll(branchApp, "use starDropped")
  git(branchApp, "update-ref", "refs/remotes/origin/main", "HEAD")
  rmSync(join(branchApp, "server/use.ts"))
})

afterAll(() => {
  rmSync(root, { force: true, recursive: true })
})

describe("consumer check", () => {
  it("lists the removed subpaths, their facade form and the removed names", () => {
    const result = check(roots(join(root, "clean-app")))

    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^ {2}@vite-hub\/demo\/extra +export subpath$/m)
    expect(result.stdout).toMatch(/^ {2}vite-hub\/demo\/extra +facade form of @vite-hub\/demo\/extra$/m)
    expect(result.stdout).toMatch(/^ {2}dropped +export of @vite-hub\/demo$/m)
    expect(result.stdout).toMatch(/^ {2}starDropped +export of @vite-hub\/demo$/m)
    expect(result.stdout).not.toMatch(/^ {2}(?:keep|Kept|extra) /m)
    expect(result.stdout).toContain("No project uses a removed surface.")
  })

  it("fails with the project, file and line of each use", () => {
    const usedApp = join(root, "used-app")
    const branchApp = join(root, "branch-app")

    const result = check(roots(usedApp, branchApp, join(root, "clean-app")))

    expect(result.status).toBe(1)
    expect(result.stdout).toContain("dropped: USED")
    expect(result.stdout).toContain(`${usedApp}:src/auth.ts:1 (working tree)`)
    expect(result.stdout).toContain("starDropped: USED")
    expect(result.stdout).toContain(`${branchApp}:server/use.ts:1 (origin/main)`)
    expect(result.stdout).not.toContain("node_modules")
    expect(result.stdout).not.toContain("dist/server.js")
    expect(result.stdout).not.toContain("clean-app")
  })

  it("does not fail on a hit that is only in a patch", () => {
    const patchedApp = join(root, "patched-app")

    const result = check(roots(patchedApp))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("vite-hub/demo/extra: only in patches/, needs a human read")
    expect(result.stdout).toContain(`${patchedApp}:patches/vite-hub.patch:1 (working tree; patch, read it)`)
  })

  it("searches --name text and reads roots from a file without rg", () => {
    const usedApp = consumer("env-app", { ".env.example": "DEMO_TOKEN=\n" })
    const rootsFile = join(root, "roots")
    write(rootsFile, `# my projects\n${usedApp}\n\n`)
    const bin = join(root, "bin-without-rg")
    mkdirSync(bin, { recursive: true })
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(bin, "git"))

    const result = check({ PATH: bin, VITEHUB_CONSUMER_ROOTS_FILE: rootsFile }, "--name", "DEMO_TOKEN")

    expect(result.status).toBe(1)
    expect(result.stdout).toMatch(/^ {2}DEMO_TOKEN +--name$/m)
    expect(result.stdout).toContain(`${usedApp}:.env.example:1 (working tree)`)
  })

  it("exits 2 and explains the setup when no roots are configured", () => {
    const result = check({})

    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("No consumer roots are configured")
    expect(result.stderr).toContain("VITEHUB_CONSUMER_ROOTS=")
    expect(result.stderr).toContain(join(root, "home/.config/vitehub/consumer-roots"))
  })
})
