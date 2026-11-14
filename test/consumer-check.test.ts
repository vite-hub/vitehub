import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const script = resolve(import.meta.dirname, "../scripts/consumer-check.mjs")
const defaultSources = {
  assignment: "const value = {}\nexport default value\n",
  declaration: "export default function module() {}\n",
  anonymous: "export default class {}\n",
  reexport: "export { keep as default } from './index.ts'\n",
}
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
let realGit = ""

function searchPath(name: string, commands: Record<string, string> = {}) {
  const bin = join(root, name)
  mkdirSync(bin, { recursive: true })
  if (!commands.git) symlinkSync(realGit, join(bin, "git"))
  for (const [command, source] of Object.entries(commands)) {
    write(join(bin, command), `#!${process.execPath}\n${source}\n`)
    chmodSync(join(bin, command), 0o755)
  }
  return bin
}

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
  realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  repo = join(root, "repo")
  mkdirSync(join(root, "home"))
  git(root, "init", "-q", repo)

  const demoExports = {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./extra": { types: "./dist/extra.d.ts", import: "./dist/extra.js" },
    ...Object.fromEntries(Object.keys(defaultSources).map(name => [`./${name}`, { import: `./dist/${name}.js` }])),
    "./star": { import: "./dist/star.js" },
  }
  write(join(repo, "packages/demo/package.json"), JSON.stringify({ name: "@vite-hub/demo", exports: demoExports }))
  write(join(repo, "packages/demo/src/index.ts"), "export function keep() {}\nexport function dropped() {}\nexport * from \"./more.ts\"\n")
  write(join(repo, "packages/demo/src/more.ts"), "export const starDropped = 1\nexport type Kept = string\n")
  write(join(repo, "packages/demo/src/extra.ts"), "export const extra = 1\n")
  for (const [name, source] of Object.entries(defaultSources)) write(join(repo, `packages/demo/src/${name}.ts`), source)
  write(join(repo, "packages/demo/src/star.ts"), "export * from './assignment.ts'\n")
  write(join(repo, "packages/vite-hub/package.json"), JSON.stringify({
    name: "vite-hub",
    exports: {
      "./demo": { import: "./dist/demo.js" },
      "./demo/extra": { import: "./dist/demo/extra.js" },
      "./demo/assignment": { import: "./dist/demo/assignment.js" },
      "./nuxt": { import: "./dist/nuxt.js" },
    },
  }))
  write(join(repo, "packages/vite-hub/src/demo.ts"), "export * from \"@vite-hub/demo\"\n")
  write(join(repo, "packages/vite-hub/src/demo/extra.ts"), "export * from \"@vite-hub/demo/extra\"\n")
  write(join(repo, "packages/vite-hub/src/demo/assignment.ts"), "export { default } from '@vite-hub/demo/assignment'\n")
  const nuxt = readFileSync(resolve(import.meta.dirname, "../packages/vite-hub/src/nuxt.ts"), "utf8")
  expect(nuxt).toContain("export default viteHubNuxtModule")
  write(join(repo, "packages/vite-hub/src/nuxt.ts"), nuxt)
  base = commitAll(repo, "base")

  const { "./extra": _extra, ...keptExports } = demoExports
  write(join(repo, "packages/demo/package.json"), JSON.stringify({ name: "@vite-hub/demo", exports: keptExports }))
  write(join(repo, "packages/demo/src/index.ts"), "export function keep() {}\nexport * from \"./more.ts\"\n")
  write(join(repo, "packages/demo/src/more.ts"), "export type Kept = string\n")
  rmSync(join(repo, "packages/demo/src/extra.ts"))
  for (const name of Object.keys(defaultSources)) write(join(repo, `packages/demo/src/${name}.ts`), "")
  write(join(repo, "packages/vite-hub/src/nuxt.ts"), nuxt.replace("export default viteHubNuxtModule", ""))
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

  it("searches module specifiers when an entry loses its own default export", () => {
    const app = consumer("default-app", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['vite-hub/nuxt'] })\n",
      "src/defaults.ts": Object.keys(defaultSources).map((name, index) => `import arbitrary${index} from '@vite-hub/demo/${name}'`).join("\n"),
      "src/facade.ts": "import arbitrary from 'vite-hub/demo/assignment'\n",
      "src/star.ts": "import { keep } from '@vite-hub/demo/star'\n",
    })

    const result = check(roots(app))

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`${app}:nuxt.config.ts:1 (working tree)`)
    expect(result.stdout).toContain("vite-hub/nuxt: USED")
    for (const name of Object.keys(defaultSources)) expect(result.stdout).toContain(`@vite-hub/demo/${name}: USED`)
    expect(result.stdout).toContain("vite-hub/demo/assignment: USED")
    expect(result.stdout).not.toContain("@vite-hub/demo/star")
    expect(result.stdout).not.toMatch(/^ {2}default /m)
  })

  it.each(["missing", "file"])("rejects a %s consumer root instead of reporting no use", (kind) => {
    const path = join(root, `invalid-root-${kind}`)
    if (kind === "file") write(path, "not a directory\n")

    const result = check(roots(join(root, "clean-app"), path))

    expect(result.status).toBe(2)
    expect(result.stderr).toContain(path)
    expect(result.stdout).not.toContain("No project uses")
    expect(result.stdout).not.toContain("Searched ")
  })

  it.each(["rg", "git working tree", "git default branch"])("rejects an incomplete %s search", (backend) => {
    const failure = "console.error('search backend failed'); process.exit(2)"
    const commands: Record<string, string> = backend === "rg" ? { rg: failure } : {
      git: `
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === 'grep' && args.includes('--no-index') === ${backend === "git working tree"}) { ${failure} }
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 2)`,
    }
    const path = searchPath(`failed-${backend}`, commands)
    const app = join(root, backend === "git default branch" ? "branch-app" : "used-app")

    const result = check({ ...roots(app), PATH: path })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("search backend failed")
    expect(result.stderr).toContain(app)
    expect(result.stdout).not.toContain("No project uses")
    expect(result.stdout).not.toContain("Searched ")
  })

  it.each(["rg", "git"])("finds hidden current-branch configuration with %s", (backend) => {
    const app = consumer(`hidden-${backend}`, { "app.ts": "export {}\n" })
    git(root, "init", "-q", app)
    commitAll(app, "base")
    git(app, "update-ref", "refs/remotes/origin/main", "HEAD")
    write(join(app, ".github/workflows/build.yml"), "env: { REMOVED_TOKEN: value }\n")
    write(join(app, ".cache/generated.ts"), "REMOVED_TOKEN\n")
    write(join(app, ".worktrees/old/app.ts"), "REMOVED_TOKEN\n")
    commitAll(app, "current branch config")
    const environment: Record<string, string> = backend === "git" ? { PATH: searchPath("hidden-without-rg") } : {}

    const result = check({ ...roots(app), ...environment }, "--name", "REMOVED_TOKEN")

    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`${app}:.github/workflows/build.yml:1 (working tree)`)
    expect(result.stdout).not.toContain(".cache/")
    expect(result.stdout).not.toContain(".worktrees/")
  })

  it("searches --name text and reads roots from a file without rg", () => {
    const usedApp = consumer("env-app", { ".env.example": "DEMO_TOKEN=\n" })
    const rootsFile = join(root, "roots")
    write(rootsFile, `# my projects\n${usedApp}\n\n`)
    const bin = searchPath("bin-without-rg")

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
