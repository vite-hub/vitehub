import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

import { getCloudflareWorkflowClassName } from "../src/integrations/cloudflare.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const nitroBin = join(playgroundDir, "node_modules", ".bin", "nitro")
const viteBin = join(playgroundDir, "node_modules", ".bin", "vite")
const buildOutputTestTimeout = 60_000
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

async function writeWorkflowNitroConfig(rootDir: string, options: {
  env?: boolean
  omitWorkflowOptions?: boolean
  provider?: "vercel"
} = {}) {
  const imports = options.env
    ? [
        `import { env } from "@vite-hub/env/nitro"`,
        `import { defineNitroConfig } from "nitro/config"`,
      ]
    : [`import { defineNitroConfig } from "nitro/config"`]
  const modules = options.env
    ? `["@vite-hub/env/nitro", "@vite-hub/workflow/nitro"]`
    : `["@vite-hub/workflow/nitro"]`
  const workflow = options.omitWorkflowOptions
    ? []
    : [`  workflow: ${options.provider ? `{ provider: "${options.provider}" }` : "{}"},`]
  const envConfig = options.env
    ? [`  env: { vertex: { apiKey: env({ secret: true }) } },`]
    : []

  await writeFile(join(rootDir, "nitro.config.ts"), [
    ...imports,
    "",
    "export default defineNitroConfig({",
    `  modules: ${modules},`,
    ...envConfig,
    ...workflow,
    `  serverDir: "./server",`,
    "})",
    "",
  ].join("\n"), "utf8")
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite workflow provider outputs", () => {
  it("builds the playground and emits cloudflare and vercel workflow outputs", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-vite-playground-")

    await execFileAsync(viteBin, ["build"], {
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
    expect(cloudflareWorkerContents).toContain('runViteHubWorkflowDefinition("welcome"')
    expect(await readFile(cloudflareWorkerBundle, "utf8")).toContain("runViteHubWorkflowDefinition")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
  }, buildOutputTestTimeout)

  it("exports Cloudflare workflow classes from Nitro output", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-nitro-playground-")
    await writeWorkflowNitroConfig(rootDir)

    await execFileAsync(nitroBin, ["build", "--preset", "cloudflare-module"], {
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
    expect(serverEntryContents).toContain('__vitehubRunNitroWorkflowDefinition("welcome"')
  }, buildOutputTestTimeout)

  it("infers Nitro Cloudflare workflow output when workflow options are omitted", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-nitro-cloudflare-inferred-")
    await writeWorkflowNitroConfig(rootDir, { omitWorkflowOptions: true })

    await execFileAsync(nitroBin, ["build", "--preset", "cloudflare-module"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_NITRO_MODE: "workflow" },
    })

    const wrangler = JSON.parse(await readFile(join(rootDir, ".output", "server", "wrangler.json"), "utf8"))
    const className = getCloudflareWorkflowClassName("welcome")

    expect(wrangler.workflows).toContainEqual({
      binding: "WORKFLOW_77656C636F6D65",
      class_name: className,
      name: "workflow--77656c636f6d65",
    })
  }, buildOutputTestTimeout)

  it("applies @vite-hub/env Runtime Env in Nitro Cloudflare workflows", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-nitro-env-")
    await writeWorkflowNitroConfig(rootDir, { env: true })

    await execFileAsync(nitroBin, ["build", "--preset", "cloudflare-module"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_NITRO_MODE: "workflow" },
    })

    const serverEntryContents = await readFile(join(rootDir, ".output", "server", "index.mjs"), "utf8")

    expect(serverEntryContents).toContain("applyRuntimeEnvToRuntimeConfig")
    expect(serverEntryContents).toContain("VERTEX_API_KEY")
    expect(serverEntryContents).toContain("applyWorkflowRuntimeEnv(runtimeConfig, env)")
    expect(serverEntryContents).not.toContain("applyWorkflowRuntimeEnv(runtimeConfig)\n  setWorkflowRuntimeConfig")
  }, buildOutputTestTimeout)

  it("does not emit Cloudflare workflow artifacts for Vercel provider overrides", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-vercel-override-")
    const viteConfig = join(rootDir, "vite.config.ts")
    await writeFile(viteConfig, (await readFile(viteConfig, "utf8")).replaceAll("workflow: {},", "workflow: { provider: \"vercel\" },"))

    await execFileAsync(viteBin, ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    expect(existsSync(join(rootDir, "dist", "vite"))).toBe(false)
    expect(existsSync(join(rootDir, ".vercel", "output", "config.json"))).toBe(true)
  }, buildOutputTestTimeout)

  it("does not emit provider deployment artifacts for OpenWorkflow provider overrides", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-openworkflow-override-")
    const viteConfig = join(rootDir, "vite.config.ts")
    await writeFile(
      viteConfig,
      (await readFile(viteConfig, "utf8")).replaceAll(
        "workflow: {},",
        "workflow: { provider: \"openworkflow\", postgres: { url: \"postgres://example\" } },",
      ),
    )

    await execFileAsync(viteBin, ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    expect(existsSync(join(rootDir, ".vercel"))).toBe(false)
    expect(existsSync(join(rootDir, "dist", "vite"))).toBe(false)
  }, buildOutputTestTimeout)

  it("does not emit Nitro Cloudflare workflow artifacts for Vercel provider overrides", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-nitro-vercel-override-")
    await writeWorkflowNitroConfig(rootDir, { provider: "vercel" })

    await execFileAsync(nitroBin, ["build", "--preset", "cloudflare-module"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_NITRO_MODE: "workflow" },
    })

    const wrangler = JSON.parse(await readFile(join(rootDir, ".output", "server", "wrangler.json"), "utf8"))
    const serverEntryContents = await readFile(join(rootDir, ".output", "server", "index.mjs"), "utf8")

    expect(wrangler.workflows).toBeUndefined()
    expect(serverEntryContents).not.toContain("extends ViteHubWorkflowEntrypoint")
  }, buildOutputTestTimeout)
})
