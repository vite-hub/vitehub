import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const tempDirs: string[] = []

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  await mkdir(baseDir, { recursive: true })
  const rootDir = await mkdtemp(join(baseDir, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

async function createPlaygroundCopy(prefix: string) {
  const workspaceDir = await createWorkspaceTempDir(prefix)
  const rootDir = join(workspaceDir, "vite")
  const nodeModules = join(playgroundDir, "node_modules")

  await mkdir(rootDir, { recursive: true })
  await cp(resolve(playgroundDir, "../_shared"), join(workspaceDir, "_shared"), { recursive: true })
  await cp(join(playgroundDir, "package.json"), join(rootDir, "package.json"))
  await cp(join(playgroundDir, "vite.config.ts"), join(rootDir, "vite.config.ts"))
  await cp(join(playgroundDir, "nitro.config.ts"), join(rootDir, "nitro.config.ts"))
  await cp(join(playgroundDir, "src"), join(rootDir, "src"), { recursive: true })
  await cp(join(playgroundDir, "server"), join(rootDir, "server"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")

  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite workflow provider outputs", () => {
  it("builds the playground and emits cloudflare and vercel workflow outputs", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-vite-playground-")

    await execFileAsync("pnpm", ["exec", "vite", "build"], {
      cwd: rootDir,
      env: process.env,
    })

    const cloudflareWorker = join(rootDir, "dist", "vite", "index.js")
    const cloudflareConfig = join(rootDir, "dist", "vite", "wrangler.json")
    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const wrangler = JSON.parse(await readFile(cloudflareConfig, "utf8"))

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(wrangler.workflows).toContainEqual({
      binding: "WORKFLOW_77656C636F6D65",
      class_name: "ViteHubWelcomeWorkflow",
      name: "workflow--77656c636f6d65",
    })
    expect(await readFile(cloudflareWorker, "utf8")).toContain("ViteHubWelcomeWorkflow")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
  }, 20_000)
})
