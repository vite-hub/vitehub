import { existsSync, readFileSync } from "node:fs"
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { resolveConfig } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { collectViteHubProvisionSteps } from "../src/cli.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const repoRoot = resolve(playgroundDir, "../..")
const workspacePackages = ["runtime", "shell", "source", "sandbox", "workspace", "agent", "auth", "blob", "cli", "database", "env", "kv", "queue", "schedule", "workflow"] as const
const tempDirs: string[] = []
const execMaxBuffer = 16 * 1024 * 1024

function resolvePlaygroundNodeModules() {
  const nodeModules = join(playgroundDir, "node_modules")
  return existsSync(nodeModules) ? nodeModules : resolve(playgroundDir, "../../node_modules")
}

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
  const nodeModules = resolvePlaygroundNodeModules()

  await mkdir(rootDir, { recursive: true })
  await cp(resolve(playgroundDir, "../_shared"), join(workspaceDir, "_shared"), { recursive: true })
  await cp(join(playgroundDir, "build"), join(rootDir, "build"), { recursive: true })
  await cp(join(playgroundDir, "package.json"), join(rootDir, "package.json"))
  await cp(join(playgroundDir, "vite.config.ts"), join(rootDir, "vite.config.ts"))
  await cp(join(playgroundDir, "src"), join(rootDir, "src"), { recursive: true })
  await cp(join(playgroundDir, "server"), join(rootDir, "server"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")

  return rootDir
}

async function readGeneratedJavaScript(outputDir: string): Promise<string> {
  const chunks: string[] = []
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) chunks.push(await readFile(path, "utf8"))
    }
  }
  await walk(outputDir)
  return chunks.join("\n")
}

function readLiveSmokeStepEnv(stepName: string): Record<string, string> {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/live-smoke.yml"), "utf8")
  const lines = workflow.split(/\r?\n/)
  const stepStart = lines.findIndex(line => line.trim() === `- name: ${stepName}`)
  if (stepStart === -1) {
    throw new Error(`Missing live-smoke step: ${stepName}`)
  }

  const stepEnd = lines.findIndex((line, index) => index > stepStart && /^ {6}- name: /.test(line))
  const stepLines = lines.slice(stepStart, stepEnd === -1 ? undefined : stepEnd)
  const envStart = stepLines.findIndex(line => /^ {8}env:\s*$/.test(line))
  if (envStart === -1) return {}

  const env: Record<string, string> = {}
  for (const line of stepLines.slice(envStart + 1)) {
    const match = /^ {10}([A-Z0-9_]+):\s*(.+?)\s*$/.exec(line)
    if (!match) break
    env[match[1]!] = match[2]!
  }
  return env
}

async function withEnv<T>(env: Record<string, string>, callback: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }

  try {
    return await callback()
  }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

beforeAll(async () => {
  for (const name of workspacePackages) {
    await execFileAsync("vp", ["run", "--filter", `@vite-hub/${name}`, "build"], {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: execMaxBuffer,
    })
  }
}, 240_000)

describe("unified vite e2e hosted outputs", () => {
  it("collects cloudflare D1 provisioning from the live-smoke e2e provision step", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-internal-vite-e2e-provision-")
    const env = readLiveSmokeStepEnv("Provision Cloudflare resources")

    expect(env.VITEHUB_HOSTING).toBe("cloudflare")
    expect(env.VITEHUB_VITE_MODE).toBe("e2e")

    await withEnv(env, async () => {
      const config = await resolveConfig({ root: rootDir }, "serve", "development")
      const stepIds = (await collectViteHubProvisionSteps(config.plugins)).map(step => step.id)

      expect(stepIds).toEqual(expect.arrayContaining([
        "database:cloudflare-d1",
        "queue:cloudflare-queues",
      ]))
    })
  }, 45_000)

  it("keeps the cloudflare artifact provider-pure and preserves hosted bindings", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-internal-vite-e2e-cf-")

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: {
        ...process.env,
        BLOB_BUCKET_NAME: "assets",
        KV_NAMESPACE_ID: "kv-namespace",
        TURSO_AUTH_TOKEN: "token",
        TURSO_DATABASE_URL: "libsql://db.example.turso.io",
        TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
        VITEHUB_D1_ANALYTICS_DATABASE_ID: "analytics-d1-id",
        VITEHUB_D1_DATABASE_ID: "primary-d1-id",
        VITEHUB_CLOUDFLARE_WORKER_NAME: "vitehub-playground-vite",
        VITEHUB_HOSTING: "cloudflare",
        VITEHUB_VITE_MODE: "e2e",
      },
      maxBuffer: execMaxBuffer,
    })

    const cloudflareWorker = join(rootDir, "dist", "vite", "index.js")
    const cloudflareConfig = JSON.parse(await readFile(join(rootDir, "dist", "vite", "wrangler.json"), "utf8"))
    const cloudflareWorkerContents = await readFile(cloudflareWorker, "utf8")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(cloudflareWorkerContents).not.toMatch(/from\s+["']@vercel\/functions["']/)
    expect(cloudflareWorkerContents).not.toMatch(/require\(["']@vercel\/functions["']\)/)
    expect(cloudflareWorkerContents).not.toMatch(/from\s+["']@cloudflare\/sandbox["']/)
    expect(cloudflareWorkerContents).not.toMatch(/require\(["']@cloudflare\/sandbox["']\)/)
    expect(cloudflareWorkerContents).not.toContain('import("vite")')
    expect(cloudflareWorkerContents).not.toContain("createRequire(import.meta.url)")
    expect(cloudflareConfig.kv_namespaces).toContainEqual({
      binding: "KV",
      id: "kv-namespace",
    })
    expect(cloudflareConfig.r2_buckets).toContainEqual({
      binding: "BLOB",
      bucket_name: "assets",
    })
    expect(cloudflareConfig.d1_databases).toHaveLength(2)
    expect(cloudflareConfig.d1_databases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: "DB",
        database_name: "vitehub-playground-db",
        database_id: "primary-d1-id",
        migrations_dir: "server/databases/primary/migrations",
      }),
      expect.objectContaining({
        binding: "DB_ANALYTICS",
        database_name: "vitehub-playground-analytics",
        database_id: "analytics-d1-id",
        migrations_dir: "server/databases/analytics/migrations",
      }),
    ]))
    expect(cloudflareConfig.name).toBe("vitehub-playground-vite")
    expect(cloudflareConfig.containers).toContainEqual(expect.objectContaining({
      class_name: "Sandbox",
      name: "vitehub-playground-vite-sandbox",
    }))
    expect(cloudflareConfig.workflows).toHaveLength(1)
    expect(cloudflareConfig.workflows?.[0]).toMatchObject({ name: "workflow--77656c636f6d65" })
    expect(cloudflareWorkerContents).toContain('name: "welcome"')
    expect(cloudflareConfig.queues?.producers).toHaveLength(1)
    expect(cloudflareConfig.queues?.consumers).toHaveLength(1)
    expect(cloudflareConfig.durable_objects?.bindings).toBeTruthy()
    expect(cloudflareConfig.migrations).toBeTruthy()
    expect(cloudflareConfig.artifacts).toBeUndefined()
  }, 45_000)

  it("uses provision state for cloudflare D1 bindings", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-internal-vite-e2e-cf-provision-")
    await mkdir(join(rootDir, ".vitehub"), { recursive: true })
    await writeFile(join(rootDir, ".vitehub", "provision.json"), `${JSON.stringify({
      cloudflare: {
        d1: {
          analytics: "analytics-d1-id",
          primary: "primary-d1-id",
        },
      },
    }, null, 2)}\n`)

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: {
        ...process.env,
        BLOB_BUCKET_NAME: "assets",
        KV_NAMESPACE_ID: "kv-namespace",
        TURSO_AUTH_TOKEN: "token",
        TURSO_DATABASE_URL: "libsql://db.example.turso.io",
        TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
        VITEHUB_CLOUDFLARE_WORKER_NAME: "vitehub-playground-vite",
        VITEHUB_HOSTING: "cloudflare",
        VITEHUB_VITE_MODE: "e2e",
      },
      maxBuffer: execMaxBuffer,
    })

    const cloudflareConfig = JSON.parse(await readFile(join(rootDir, "dist", "vite", "wrangler.json"), "utf8"))

    expect(cloudflareConfig.d1_databases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: "DB",
        database_id: "primary-d1-id",
        database_name: "vitehub-playground-db",
      }),
      expect.objectContaining({
        binding: "DB_ANALYTICS",
        database_id: "analytics-d1-id",
        database_name: "vitehub-playground-analytics",
      }),
    ]))
  }, 45_000)

  it("keeps the vercel artifact unified while preserving queue server outputs", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-internal-vite-e2e-vercel-")

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: {
        ...process.env,
        BLOB_READ_WRITE_TOKEN: "blob-token",
        KV_REST_API_TOKEN: "kv-token",
        KV_REST_API_URL: "https://upstash.example.com",
        TURSO_AUTH_TOKEN: "token",
        TURSO_ANALYTICS_DATABASE_URL: "libsql://analytics.example.turso.io",
        TURSO_DATABASE_URL: "libsql://db.example.turso.io",
        VITEHUB_HOSTING: "vercel",
        VITEHUB_VITE_MODE: "e2e",
        VITE_SANDBOX_PROJECT_ID: "project-id",
        VITE_SANDBOX_TEAM_ID: "team-id",
        VITE_SANDBOX_TOKEN: "sandbox-token",
      },
      maxBuffer: execMaxBuffer,
    })

    const vercelConfig = await readFile(join(rootDir, ".vercel", "output", "config.json"), "utf8")
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const vercelConsumer = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", "index.mjs")
    const vercelSchedule = join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "schedules", "vercel", "daily-marker.func", "index.mjs")
    const vercelConsumerConfig = JSON.parse(await readFile(join(rootDir, ".vercel", "output", "functions", "api", "vitehub", "queues", "vercel", "welcome-email", "welcome-email.func", ".vc-config.json"), "utf8"))
    const vercelServerConfig = JSON.parse(await readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", ".vc-config.json"), "utf8"))
    const vercelConsumerContents = await readFile(vercelConsumer, "utf8")
    const vercelScheduleContents = await readFile(vercelSchedule, "utf8")
    const vercelServerContents = await readFile(vercelServer, "utf8")

    expect(vercelConfig).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(existsSync(vercelConsumer)).toBe(true)
    expect(vercelServerContents).toContain("/api/database")
    expect(vercelServerContents).toContain("/api/database/analytics")
    expect(vercelServerContents).toContain("/api/blob")
    expect(vercelServerContents).toContain("/api/workflows/welcome")
    expect(vercelServerContents).toContain("vercel-blob")
    expect(vercelServerContents).toContain('"access": "private",\n    "driver": "vercel-blob"')
    expect(vercelServerContents).not.toContain('import("files-sdk")')
    expect(vercelServerContents).not.toContain('import("files-sdk/vercel-blob")')
    expect(vercelServerContents).not.toContain("requires files-sdk")
    expect(vercelServerContents).not.toContain('from "@vercel/blob"')
    expect(vercelServerContents).not.toContain("from '@vercel/blob'")
    expect(vercelServerContents).not.toContain('import("vite")')
    expect(vercelServerConfig.runtime).toBe("nodejs22.x")
    expect(vercelConsumerContents).toContain("waitUntil")
    expect(vercelConsumerContents).toContain("handleHostedVercelQueueCallback")
    expect(vercelScheduleContents).toContain("process.env.CRON_SECRET")
    expect(vercelScheduleContents).toContain("authorization !== `Bearer ${cronSecret}`")
    expect(vercelConsumerConfig.experimentalTriggers?.[0]).toEqual({
      consumer: "api_Svitehub_Squeues_Svercel_Swelcome-email_Swelcome-email_Dfunc",
      topic: "topic--77656c636f6d652d656d61696c",
      type: "queue/v2beta",
    })
  }, 45_000)

  it("builds the env and chat playground modes", async () => {
    const envRoot = await createPlaygroundCopy("vitehub-internal-vite-env-")

    await execFileAsync("vp", ["build"], {
      cwd: envRoot,
      env: {
        ...process.env,
        VITEHUB_VITE_MODE: "env",
      },
      maxBuffer: execMaxBuffer,
    })

    const envOutput = await readGeneratedJavaScript(join(envRoot, "dist"))
    expect(envOutput).toContain("Vite playground")
    expect(envOutput).toContain("enabled")

    const chatRoot = await createPlaygroundCopy("vitehub-internal-vite-chat-")

    await execFileAsync("vp", ["build"], {
      cwd: chatRoot,
      env: {
        ...process.env,
        VITEHUB_VITE_MODE: "chat",
      },
      maxBuffer: execMaxBuffer,
    })

    const chatOutput = await readGeneratedJavaScript(join(chatRoot, "dist"))
    expect(chatOutput).toContain("playground-mock")
    expect(chatOutput).toContain("CLI Dev Agent")
  }, 45_000)

  it("writes Netlify agent HTTP function output from the chat playground", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-internal-vite-netlify-agent-")

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: {
        ...process.env,
        VITEHUB_HOSTING: "netlify",
        VITEHUB_VITE_MODE: "chat",
      },
      maxBuffer: execMaxBuffer,
    })

    const source = await readFile(join(rootDir, ".vitehub", "agent", "netlify-function.mjs"), "utf8")
    const functionFile = await readFile(join(rootDir, ".netlify", "v1", "functions", "vitehub-agent.mjs"), "utf8")
    const config = JSON.parse(await readFile(join(rootDir, ".netlify", "v1", "config.json"), "utf8"))

    expect(source).toContain("viteHubAgentNetlifyFunction")
    expect(functionFile).toContain("export const config = {")
    expect(functionFile).toContain("\"name\": \"vitehub-agent\"")
    expect(functionFile).toContain("\"nodeBundler\": \"esbuild\"")
    expect(functionFile).toContain("\"/api/_vitehub/agents/:agent/chat\"")
    expect(functionFile).toContain("\"/api/_vitehub/agents/:agent/webhooks/:webhook\"")
    expect(config).toEqual({})
  }, 45_000)
})
