import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

import { getCloudflareWorkflowClassName } from "../src/integrations/cloudflare.ts"

const execFileAsync = promisify(execFile)
const nuxtPlaygroundDir = resolve(import.meta.dirname, "../../../playground/nuxt")
const vitePlaygroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const tempDirs: string[] = []

async function createWorkspaceTempDir(baseDir: string, prefix: string) {
  const tempRoot = join(baseDir, ".vitest-tmp")
  await mkdir(tempRoot, { recursive: true })
  const rootDir = await mkdtemp(join(tempRoot, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

async function createVitePlaygroundCopy(prefix: string) {
  const workspaceDir = await createWorkspaceTempDir(vitePlaygroundDir, prefix)
  const rootDir = join(workspaceDir, "vite")
  const nodeModules = join(vitePlaygroundDir, "node_modules")

  await mkdir(rootDir, { recursive: true })
  await cp(resolve(vitePlaygroundDir, "../_shared"), join(workspaceDir, "_shared"), { recursive: true })
  await cp(join(vitePlaygroundDir, "package.json"), join(rootDir, "package.json"))
  await cp(join(vitePlaygroundDir, "vite.config.ts"), join(rootDir, "vite.config.ts"))
  await cp(join(vitePlaygroundDir, "nitro.config.ts"), join(rootDir, "nitro.config.ts"))
  await cp(join(vitePlaygroundDir, "src"), join(rootDir, "src"), { recursive: true })
  await cp(join(vitePlaygroundDir, "server"), join(rootDir, "server"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")

  return rootDir
}

async function createNuxtPlaygroundCopy(prefix: string) {
  const workspaceDir = await createWorkspaceTempDir(nuxtPlaygroundDir, prefix)
  const rootDir = join(workspaceDir, "nuxt")
  const nodeModules = join(nuxtPlaygroundDir, "node_modules")

  await mkdir(rootDir, { recursive: true })
  await cp(join(nuxtPlaygroundDir, "package.json"), join(rootDir, "package.json"))
  await cp(join(nuxtPlaygroundDir, "nuxt.config.ts"), join(rootDir, "nuxt.config.ts"))
  await cp(join(nuxtPlaygroundDir, "app"), join(rootDir, "app"), { recursive: true })
  await cp(join(nuxtPlaygroundDir, "server"), join(rootDir, "server"), { recursive: true })
  await symlink(nodeModules, join(rootDir, "node_modules"), "dir")

  return rootDir
}

async function runNuxtBuild(rootDir: string, env: Record<string, string | undefined>) {
  await execFileAsync("pnpm", ["exec", "nuxi", "build"], {
    cwd: rootDir,
    env: { ...process.env, ...env },
  })
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("workflow provider outputs", () => {
  it("builds the Vite playground and emits cloudflare and vercel workflow outputs", async () => {
    const rootDir = await createVitePlaygroundCopy("vitehub-workflow-vite-playground-")

    await execFileAsync("pnpm", ["exec", "vite", "build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    const cloudflareWorker = join(rootDir, "dist", "vite", "index.js")
    const cloudflareWorkerBundle = join(rootDir, "dist", "vite", "worker.mjs")
    const cloudflareConfig = join(rootDir, "dist", "vite", "wrangler.json")
    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const wrangler = JSON.parse(await readFile(cloudflareConfig, "utf8"))
    const className = getCloudflareWorkflowClassName("welcome")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(existsSync(cloudflareWorkerBundle)).toBe(true)
    expect(wrangler.workflows).toContainEqual({
      binding: "WORKFLOW_77656C636F6D65",
      class_name: className,
      name: "workflow--77656c636f6d65",
    })
    expect(wrangler.workflows).toHaveLength(1)
    const cloudflareWorkerContents = await readFile(cloudflareWorker, "utf8")
    expect(cloudflareWorkerContents).toContain("waitUntil as viteHubWaitUntil")
    expect(cloudflareWorkerContents).toContain(`export class ${className} extends WorkflowEntrypoint`)
    expect(await readFile(cloudflareWorkerBundle, "utf8")).toContain("runViteHubWorkflowDefinition")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
  }, 30_000)

  it("exports Cloudflare workflow classes from Nitro output", async () => {
    const rootDir = await createVitePlaygroundCopy("vitehub-workflow-nitro-playground-")

    await execFileAsync("pnpm", ["exec", "nitro", "build", "--preset", "cloudflare-module"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_NITRO_MODE: "workflow" },
    })

    const serverEntry = join(rootDir, ".output", "server", "index.mjs")
    const wrangler = JSON.parse(await readFile(join(rootDir, ".output", "server", "wrangler.json"), "utf8"))
    const serverEntryContents = await readFile(serverEntry, "utf8")
    const className = getCloudflareWorkflowClassName("welcome")

    expect(wrangler.workflows).toContainEqual({
      binding: "WORKFLOW_77656C636F6D65",
      class_name: className,
      name: "workflow--77656c636f6d65",
    })
    expect(serverEntryContents).toContain("globalThis.__vitehubRunNitroWorkflowDefinition")
    expect(serverEntryContents).toContain(`export class ${className} extends ViteHubWorkflowEntrypoint`)
  }, 30_000)

  it("does not emit Vite Cloudflare workflow artifacts for Vercel provider overrides", async () => {
    const rootDir = await createVitePlaygroundCopy("vitehub-workflow-vercel-override-")
    const viteConfig = join(rootDir, "vite.config.ts")
    await writeFile(viteConfig, (await readFile(viteConfig, "utf8")).replace("workflow: {},", "workflow: { provider: \"vercel\" },"), "utf8")

    await execFileAsync("pnpm", ["exec", "vite", "build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    const wrangler = JSON.parse(await readFile(join(rootDir, "dist", "vite", "wrangler.json"), "utf8"))
    const cloudflareWorkerContents = await readFile(join(rootDir, "dist", "vite", "index.js"), "utf8")

    expect(wrangler.workflows).toBeUndefined()
    expect(cloudflareWorkerContents).not.toContain("extends WorkflowEntrypoint")
  }, 30_000)

  it("does not emit Nitro Cloudflare workflow artifacts for Vercel provider overrides", async () => {
    const rootDir = await createVitePlaygroundCopy("vitehub-workflow-nitro-vercel-override-")
    const nitroConfig = join(rootDir, "nitro.config.ts")
    await writeFile(nitroConfig, (await readFile(nitroConfig, "utf8")).replace("workflow: workflowEnabled ? {} : false,", "workflow: workflowEnabled ? { provider: \"vercel\" } : false,"), "utf8")

    await execFileAsync("pnpm", ["exec", "nitro", "build", "--preset", "cloudflare-module"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_NITRO_MODE: "workflow" },
    })

    const wrangler = JSON.parse(await readFile(join(rootDir, ".output", "server", "wrangler.json"), "utf8"))
    const serverEntryContents = await readFile(join(rootDir, ".output", "server", "index.mjs"), "utf8")

    expect(wrangler.workflows).toBeUndefined()
    expect(serverEntryContents).not.toContain("extends ViteHubWorkflowEntrypoint")
  }, 30_000)

  it("builds the Nuxt playground and emits Cloudflare workflow output", async () => {
    const rootDir = await createNuxtPlaygroundCopy("vitehub-workflow-nuxt-playground-")
    await runNuxtBuild(rootDir, { NITRO_PRESET: "cloudflare-module" })

    const serverEntry = join(rootDir, ".output", "server", "index.mjs")
    const nitro = JSON.parse(await readFile(join(rootDir, ".output", "nitro.json"), "utf8"))
    const serverEntryContents = await readFile(serverEntry, "utf8")
    const className = getCloudflareWorkflowClassName("welcome")

    expect(nitro.config.cloudflare.wrangler.workflows).toContainEqual({
      binding: "WORKFLOW_77656C636F6D65",
      class_name: className,
      name: "workflow--77656c636f6d65",
    })
    expect(serverEntryContents).toContain("globalThis.__vitehubRunNitroWorkflowDefinition")
    expect(serverEntryContents).toContain(`export class ${className} extends ViteHubWorkflowEntrypoint`)
  }, 45_000)

  it("builds the Nuxt playground and emits Vercel output", async () => {
    const rootDir = await createNuxtPlaygroundCopy("vitehub-workflow-nuxt-vercel-")
    await runNuxtBuild(rootDir, { NITRO_PRESET: "vercel" })

    const vercelConfig = join(rootDir, ".vercel", "output", "config.json")
    const vercelServer = join(rootDir, ".vercel", "output", "functions", "__fallback.func", "index.mjs")

    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__fallback\"")
    expect(existsSync(vercelServer)).toBe(true)
  }, 45_000)

  it("does not emit Nuxt Cloudflare workflow artifacts for Vercel provider overrides", async () => {
    const rootDir = await createNuxtPlaygroundCopy("vitehub-workflow-nuxt-vercel-override-")
    const nuxtConfig = join(rootDir, "nuxt.config.ts")
    await writeFile(nuxtConfig, (await readFile(nuxtConfig, "utf8")).replace("workflow: {},", "workflow: { provider: \"vercel\" },"), "utf8")

    await runNuxtBuild(rootDir, { NITRO_PRESET: "cloudflare-module" })

    const nitro = JSON.parse(await readFile(join(rootDir, ".output", "nitro.json"), "utf8"))
    const serverEntryContents = await readFile(join(rootDir, ".output", "server", "index.mjs"), "utf8")

    expect(nitro.config.cloudflare?.wrangler?.workflows).toBeUndefined()
    expect(serverEntryContents).not.toContain("extends ViteHubWorkflowEntrypoint")
  }, 45_000)
})
