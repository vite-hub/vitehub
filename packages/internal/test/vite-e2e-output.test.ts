import { existsSync } from "node:fs"
import { cp, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const tempDirs: string[] = []

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  const workspacePackagesDir = resolve(playgroundDir, "../../packages")
  await mkdir(baseDir, { recursive: true })
  if (!existsSync(join(baseDir, "packages"))) {
    await symlink(workspacePackagesDir, join(baseDir, "packages"), "dir")
  }
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
  await cp(join(playgroundDir, "build"), join(rootDir, "build"), { recursive: true })
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

describe("unified vite e2e hosted outputs", () => {
  it("keeps the cloudflare artifact provider-pure and preserves hosted bindings", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-internal-vite-e2e-cf-")

    await execFileAsync("pnpm", ["exec", "vite", "build"], {
      cwd: rootDir,
      env: {
        ...process.env,
        BLOB_BUCKET_NAME: "assets",
        KV_NAMESPACE_ID: "kv-namespace",
        TURSO_AUTH_TOKEN: "token",
        TURSO_DATABASE_URL: "libsql://db.example.turso.io",
        VITEHUB_HOSTING: "cloudflare",
        VITEHUB_VITE_MODE: "e2e",
      },
    })

    const cloudflareWorker = join(rootDir, "dist", "vite", "index.js")
    const cloudflareConfig = JSON.parse(await readFile(join(rootDir, "dist", "vite", "wrangler.json"), "utf8"))
    const cloudflareWorkerContents = await readFile(cloudflareWorker, "utf8")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(cloudflareWorkerContents).not.toMatch(/from\s+["']@vercel\/functions["']/)
    expect(cloudflareWorkerContents).not.toMatch(/require\(["']@vercel\/functions["']\)/)
    expect(cloudflareWorkerContents).not.toMatch(/from\s+["']@cloudflare\/sandbox["']/)
    expect(cloudflareWorkerContents).not.toMatch(/require\(["']@cloudflare\/sandbox["']\)/)
    expect(cloudflareConfig.kv_namespaces).toContainEqual({
      binding: "KV",
      id: "kv-namespace",
    })
    expect(cloudflareConfig.r2_buckets).toContainEqual({
      binding: "BLOB",
      bucket_name: "assets",
    })
    expect(cloudflareConfig.workflows).toHaveLength(1)
    expect(cloudflareConfig.queues?.producers).toHaveLength(1)
    expect(cloudflareConfig.queues?.consumers).toHaveLength(1)
    expect(cloudflareConfig.durable_objects?.bindings).toBeTruthy()
    expect(cloudflareConfig.migrations).toBeTruthy()
  }, 45_000)

  it("keeps the vercel artifact unified while preserving queue server outputs", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-internal-vite-e2e-vercel-")

    await execFileAsync("pnpm", ["exec", "vite", "build"], {
      cwd: rootDir,
      env: {
        ...process.env,
        BLOB_READ_WRITE_TOKEN: "blob-token",
        KV_REST_API_TOKEN: "kv-token",
        KV_REST_API_URL: "https://upstash.example.com",
        TURSO_AUTH_TOKEN: "token",
        TURSO_DATABASE_URL: "libsql://db.example.turso.io",
        VITEHUB_HOSTING: "vercel",
        VITEHUB_VITE_MODE: "e2e",
        VITE_SANDBOX_PROJECT_ID: "project-id",
        VITE_SANDBOX_TEAM_ID: "team-id",
        VITE_SANDBOX_TOKEN: "sandbox-token",
      },
    })

    const vercelConfig = await readFile(join(rootDir, ".vercel", "output", "config.json"), "utf8")
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const vercelConsumer = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", "index.mjs")
    const vercelConsumerContents = await readFile(vercelConsumer, "utf8")
    const vercelServerContents = await readFile(vercelServer, "utf8")

    expect(vercelConfig).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(existsSync(vercelConsumer)).toBe(true)
    expect(vercelServerContents).toContain("/api/db")
    expect(vercelServerContents).toContain("/api/blob")
    expect(vercelServerContents).toContain("/api/workflows/welcome")
    expect(vercelConsumerContents).toContain("waitUntil")
    expect(vercelConsumerContents).toContain("handleHostedVercelQueueCallback")
  }, 45_000)
})
