import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

import { getCloudflareWorkflowBindingName, getCloudflareWorkflowClassName, getCloudflareWorkflowName } from "../src/integrations/cloudflare.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const buildOutputTestTimeout = 60_000
const tempNodeModuleBuildDirs = new Set([".vite-temp"])
const tempDirs: string[] = []

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

async function linkNodeModules(sourceDir: string, targetDir: string) {
  await mkdir(targetDir, { recursive: true })
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (tempNodeModuleBuildDirs.has(entry.name)) {
      continue
    }
    const source = join(sourceDir, entry.name)
    const target = join(targetDir, entry.name)
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      await mkdir(target, { recursive: true })
      for (const scopedEntry of await readdir(source, { withFileTypes: true })) {
        await linkNodeModuleEntry(join(source, scopedEntry.name), join(target, scopedEntry.name))
      }
      continue
    }
    await linkNodeModuleEntry(source, target)
  }
}

async function linkNodeModuleEntry(source: string, target: string) {
  const resolved = await realpath(source)
  const info = await stat(resolved)
  await symlink(resolved, target, info.isDirectory() ? "dir" : "file")
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
  await linkNodeModules(nodeModules, join(rootDir, "node_modules"))

  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("Vite workflow provider outputs", () => {
  it("builds the playground and emits cloudflare and vercel workflow outputs", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-vite-playground-")
    const agentDir = join(rootDir, "server", "agents", "nuxt")
    const inlineAgentDir = join(rootDir, "server", "agents", "inline")
    await mkdir(agentDir, { recursive: true })
    await mkdir(join(agentDir, "workspace"), { recursive: true })
    await mkdir(inlineAgentDir, { recursive: true })
    await writeFile(join(agentDir, "agent.ts"), [
      `import { defineAgent } from "@vite-hub/agent"`,
      "",
      "export default defineAgent({",
      "  workspace: {},",
      `  run: () => "nuxt agent",`,
      "})",
      "",
    ].join("\n"))
    await writeFile(join(agentDir, "instructions.md"), "Keep answers concise.\n@./shared.md\n")
    await writeFile(join(agentDir, "shared.md"), "Use shared policy.\n")
    await writeFile(join(inlineAgentDir, "agent.ts"), [
      `import { defineAgent } from "@vite-hub/agent"`,
      "",
      "export default defineAgent({",
      `  runtime: false,`,
      `  run: () => "inline agent",`,
      "})",
      "",
    ].join("\n"))

    await execFileAsync("vp", ["build"], {
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
    const agentClassName = getCloudflareWorkflowClassName("nuxt")
    const devtoolsAgentClassName = getCloudflareWorkflowClassName("devtools-demo")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(existsSync(cloudflareWorkerBundle)).toBe(true)
    expect(wrangler.workflows).toContainEqual({
      binding: "WORKFLOW_77656C636F6D65",
      class_name: className,
      name: "workflow--77656c636f6d65",
    })
    expect(wrangler.workflows).toContainEqual({
      binding: getCloudflareWorkflowBindingName("nuxt"),
      class_name: agentClassName,
      name: getCloudflareWorkflowName("nuxt"),
    })
    expect(wrangler.workflows).toContainEqual({
      binding: getCloudflareWorkflowBindingName("devtools-demo"),
      class_name: devtoolsAgentClassName,
      name: getCloudflareWorkflowName("devtools-demo"),
    })
    expect(wrangler.workflows).toHaveLength(3)
    const cloudflareWorkerContents = await readFile(cloudflareWorker, "utf8")
    expect(cloudflareWorkerContents).toContain("waitUntil as viteHubWaitUntil")
    expect(cloudflareWorkerContents).toContain(`export class ${className} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain(`export class ${agentClassName} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain(`export class ${devtoolsAgentClassName} extends WorkflowEntrypoint`)
    expect(cloudflareWorkerContents).toContain('runViteHubWorkflowDefinition("welcome"')
    expect(cloudflareWorkerContents).toContain('runViteHubWorkflowDefinition("nuxt"')
    expect(cloudflareWorkerContents).not.toContain('runViteHubWorkflowDefinition("inline"')
    expect(await readFile(cloudflareWorkerBundle, "utf8")).toContain("runViteHubWorkflowDefinition")
    const registry = await readFile(join(rootDir, ".vitehub", "workflow", "registry.mjs"), "utf8")
    expect(registry).toContain("runAgentWorkflowDefinition")
    expect(registry).toContain("workspaceAgentWithSourceRoot")
    expect(registry).toContain(JSON.stringify(join(agentDir, "workspace")))
    expect(registry).toContain("Keep answers concise")
    expect(registry).toContain("Use shared policy")
    expect(registry).not.toContain("@./shared.md")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
  }, buildOutputTestTimeout)

  it("does not emit Cloudflare workflow artifacts for Vercel provider overrides", async () => {
    const rootDir = await createPlaygroundCopy("vitehub-workflow-vercel-override-")
    const viteConfig = join(rootDir, "vite.config.ts")
    await writeFile(viteConfig, (await readFile(viteConfig, "utf8")).replaceAll("workflow: {},", "workflow: { provider: \"vercel\" },"))

    await execFileAsync("vp", ["build"], {
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

    await execFileAsync("vp", ["build"], {
      cwd: rootDir,
      env: { ...process.env, VITEHUB_VITE_MODE: "workflow" },
    })

    expect(existsSync(join(rootDir, ".vercel"))).toBe(false)
    expect(existsSync(join(rootDir, "dist", "vite"))).toBe(false)
  }, buildOutputTestTimeout)

})
