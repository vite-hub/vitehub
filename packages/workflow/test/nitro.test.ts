import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"

import { transformSync } from "esbuild"
import { resolveConfig } from "vite"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import { expect, it, vi } from "vitest"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"

import { createCloudflareWorkflowNitroConfig } from "../src/internal/vite-build.ts"
import { workflowRuntimeModule } from "../src/internal/runtime-modules.ts"
import { hubWorkflow } from "../src/vite.ts"
import { nitroOrderPlugins } from "../../vite-hub/src/nitro-order.ts"
import type { WorkflowOptions } from "../src/types.ts"
import { deferWorkflow } from "../src/runtime/client.ts"
import * as workflowState from "../src/runtime/state.ts"

const generated = vi.hoisted(() => vi.fn())
vi.mock("../src/internal/vite-build.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../src/internal/vite-build.ts")>(),
  generateWorkflowProviderOutputs: generated,
}))

it("leaves implicit Workflow disabled for Netlify Nitro output", async () => {
  const nitro = { preset: "netlify" }
  await expect(createCloudflareWorkflowNitroConfig({
    nitro,
    rootDir: "/tmp/unused",
    workflow: undefined,
  })).resolves.toBe(nitro)
})

it.each([undefined, "vite-hub/workflow"])("retains a deferred start from a Nitro Cloudflare application route before its definition loads (import base: %s)", async (workflowImportBase) => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-defer-"))
  try {
    const workflowDir = join(rootDir, "server", "workflows")
    await mkdir(workflowDir, { recursive: true })
    await writeFile(join(workflowDir, "welcome.ts"), "export default async () => 'ok'\n")
    const existing = { handler: "existing.ts", route: "/health" }
    const nitro = await createCloudflareWorkflowNitroConfig({
      nitro: { preset: "cloudflare-module", handlers: [existing] },
      rootDir,
      workflow: {},
      workflowImportBase,
    })
    const handlers = nitro.handlers as Array<{ handler: string, middleware?: boolean }>
    expect(handlers).toContainEqual(existing)
    const middleware = handlers.find(handler => handler.middleware)!
    const source = await readFile(middleware.handler, "utf8")
    const pending: Promise<unknown>[] = []
    const waitUntil = vi.fn((promise: Promise<unknown>) => { pending.push(promise) })
    const createBatch = vi.fn(async () => [{ id: "welcome-1" }])
    const env = { WORKFLOW_CUSTOM: { createBatch } }
    const module = { exports: {} as { default: (event: object) => void } }
    runInNewContext(transformSync(source, { loader: "ts", format: "cjs" }).code, {
      module,
      exports: module.exports,
      require(id: string) {
        if (id === "nitro") return { defineMiddleware: (handler: (event: object) => void) => handler }
        if (id === "cloudflare:workers") return { env, waitUntil }
        if (id === workflowRuntimeModule("state")) return workflowState
        throw new Error(`Unexpected middleware import: ${id}`)
      },
    })
    workflowState.setWorkflowRuntimeConfig({ provider: "cloudflare", binding: "WORKFLOW_CUSTOM" })
    let resolveDefinition!: () => void
    const definition = new Promise<void>((resolve) => { resolveDefinition = resolve })
    workflowState.setWorkflowRuntimeRegistry({
      welcome: async () => {
        await definition
        return { default: { handler: async () => "done" } }
      },
    })
    const event = { context: {} }
    module.exports.default(event)
    expect(workflowState.getWorkflowRuntimeEvent()).toBe(event)
    const response = (() => {
      expect(deferWorkflow("welcome", { email: "test@example.com" }, { id: "welcome-1" })).toBeUndefined()
      return new Response("accepted")
    })()
    expect(response.status).toBe(200)
    expect(waitUntil).toHaveBeenCalledOnce()
    expect(createBatch).not.toHaveBeenCalled()
    resolveDefinition()
    await Promise.all(pending)
    expect(createBatch).toHaveBeenCalledExactlyOnceWith([{ id: "welcome-1", params: { email: "test@example.com" } }])
  }
  finally {
    workflowState.resetWorkflowRuntime()
    await rm(rootDir, { force: true, recursive: true })
  }
})

it("installs discovered Agent workflows into a Cloudflare Nitro entry", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-"))
  try {
    await symlink(join(import.meta.dirname, "../../../node_modules"), join(rootDir, "node_modules"), "dir")
    const agentDir = join(rootDir, "server", "agents", "calories")
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, "agent.ts"), "export default defineAgent({ driver: { run: () => 'ok' } })\n")

    const nitro = await createCloudflareWorkflowNitroConfig({
      nitro: { preset: "cloudflare-module" },
      rootDir,
      workflow: {},
    })
    // SAFETY: Cloudflare configuration creation above installs the Wrangler workflows array.
    expect((nitro.cloudflare as { wrangler: { workflows: unknown[] } }).wrangler.workflows).toEqual([
      expect.objectContaining({ class_name: expect.stringContaining("Calories"), name: expect.stringContaining("63616c6f72696573") }),
      expect.objectContaining({ class_name: expect.stringContaining("InvocationRecoveryCalories") }),
    ])
    // SAFETY: Cloudflare configuration creation above installs the Rollup plugins array.
    expect((nitro.rollupConfig as { plugins: Array<{ name: string }> }).plugins).toContainEqual(
      expect.objectContaining({ name: "vitehub-workflow-cloudflare-exports" }),
    )
    // SAFETY: Cloudflare configuration creation above installs the Rollup plugins array.
    const plugin = (nitro.rollupConfig as { plugins: Array<Record<string, any>> }).plugins
      .find(candidate => candidate.name === "vitehub-workflow-cloudflare-exports")!
    const moduleId = plugin.resolveId.handler("virtual:vitehub-workflow-cloudflare-exports")
    expect(plugin.load.handler(moduleId)).toContain("installViteHubWorkflowRuntime()")
    const workflowFile = join(agentDir, "agent.ts")
    expect(plugin.resolveId.handler(pathToFileURL(workflowFile).href)).toBe(workflowFile)
    const ids = ["virtual:vitehub-workflow-cloudflare-exports", pathToFileURL(workflowFile).href, moduleId, "virtual:vitehub-workflow-cloudflare-exports.mjs", "cloudflare:workers", workflowFile]
    expect(ids.filter(id => plugin.resolveId.filter.id.test(id))).toEqual(ids.slice(0, 2))
    expect(ids.filter(id => plugin.load.filter.id.test(id))).toEqual([moduleId])
    const renderChunk = plugin.renderChunk.handler ?? plugin.renderChunk
    expect(renderChunk.call({}, "export default {}", { fileName: "index.js", isEntry: true })).toMatchObject({
      code: expect.stringMatching(/export \{ ViteHub.*Workflow \} from '\.\/workflow-cloudflare-exports\.mjs'/),
    })
    expect(renderChunk.call({}, "export default {}", { fileName: "other.js", isEntry: true })).toBeNull()
  }
  finally {
    await rm(rootDir, { force: true, recursive: true })
  }
})

it.each([false, true])("preserves Nitro's Wrangler config while cleaning standalone Workflow output (wrapper: %s)", async (standaloneWrapper) => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-cleanup-"))
  try {
    const workflowDir = join(rootDir, "server", "workflows")
    await mkdir(workflowDir, { recursive: true })
    await writeFile(join(workflowDir, "welcome.ts"), "export default defineWorkflow(async () => 'ok')\n")
    const nitro = await createCloudflareWorkflowNitroConfig({ nitro: { preset: "cloudflare-module" }, rootDir, workflow: {} })
    // SAFETY: Cloudflare configuration creation above installs the Wrangler workflows array.
    const workflows = (nitro.cloudflare as { wrangler: { workflows: unknown[] } }).wrangler.workflows
    const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
    const worker = standaloneWrapper
      ? 'import worker, { runViteHubWorkflowDefinition } from "./worker.mjs"\n'
      : "export default { fetch() {} }\n"
    const wrangler = { compatibility_date: "2026-04-20", main: "nitro.mjs", workflows }
    await mkdir(join(outputRoot, ".vitehub", "workflow", "sources"), { recursive: true })
    await writeFile(join(outputRoot, "nitro.mjs"), "export default { fetch() {} }\n")
    await writeFile(join(outputRoot, "index.js"), worker)
    await writeFile(join(outputRoot, "worker.mjs"), "obsolete standalone Workflow bundle\n")
    await writeFile(join(outputRoot, "wrangler.json"), JSON.stringify(wrangler))

    const { generateWorkflowProviderOutputs } = await vi.importActual<typeof import("../src/internal/vite-build.ts")>("../src/internal/vite-build.ts")
    await generateWorkflowProviderOutputs({ clientOutDir: join(rootDir, "dist"), cloudflareInNitro: true, hosting: "cloudflare-module", rootDir, workflow: {} })

    await expect(readFile(join(outputRoot, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual(wrangler)
    await expect(readFile(join(outputRoot, "worker.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    if (standaloneWrapper) await expect(readFile(join(outputRoot, "index.js"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    else await expect(readFile(join(outputRoot, "index.js"), "utf8")).resolves.toBe(worker)
  }
  finally {
    await rm(rootDir, { force: true, recursive: true })
  }
})

async function runConfigHook(config: UserConfig & { nitro?: Record<string, unknown> }, hosting: string, plugins: Plugin[] = [], workflow: WorkflowOptions = {}): Promise<Record<string, unknown>> {
  let nitro: Record<string, unknown> = {}
  await resolveConfig({
    configFile: false,
    logLevel: "silent",
    ...config,
    plugins: [hubWorkflow(workflow, { hosting }), ...plugins, {
      name: "nitro:init",
      config(config) {
        // SAFETY: The Workflow hook supplies Nitro's configuration before this hook runs.
        nitro = Reflect.get(config, "nitro") as Record<string, unknown>
      },
    }, nitroOrderPlugins()],
  }, "build")
  return nitro
}

async function runProviderOutput(config: ResolvedConfig) {
  const plugin = config.plugins.find(plugin => plugin.name === "@vite-hub/workflow/vite")!
  const context = { environment: { config, name: "ssr" } }
  if (typeof plugin.buildStart !== "function" || typeof plugin.buildEnd !== "function" || typeof plugin.closeBundle !== "object") {
    throw new TypeError("Expected Workflow build hooks")
  }
  await plugin.buildStart.call(context as never, {} as never)
  await plugin.buildEnd.call(context as never)
  await plugin.closeBundle.handler.call(context as never)
}

it("adds Cloudflare Workflows to the Nitro Worker of a Vite build", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-vite-nitro-"))
  try {
    await writeFile(join(rootDir, "package.json"), "{\"type\":\"module\"}\n")
    await mkdir(join(rootDir, "server", "workflows"), { recursive: true })
    await writeFile(join(rootDir, "server", "workflows", "onboard-user.ts"), "import { defineWorkflow } from '@vite-hub/workflow'\n\nexport default defineWorkflow(async () => ({ ok: true }))\n")

    const nitro = await runConfigHook({ nitro: {}, root: rootDir }, "cloudflare-module")
    // SAFETY: The Cloudflare Nitro config above installs the Wrangler workflows array.
    expect((nitro.cloudflare as { wrangler: { workflows: unknown[] } }).wrangler.workflows).toEqual([
      expect.objectContaining({ class_name: expect.stringContaining("OnboardUser"), name: expect.stringContaining("6f6e626f6172642d75736572") }),
    ])
    // The preset stays with vitehub(), which sets it on Nitro.
    expect(nitro.preset).toBeUndefined()

    // The Nuxt module adds the Workflows through `vitehub.workflow.createNitroConfig` instead.
    const nuxtConfig = { nitro: {}, root: rootDir, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }
    const nuxt = await runConfigHook(nuxtConfig, "cloudflare-module")
    expect(nuxt.cloudflare).toBeUndefined()
    expect((await runConfigHook({ nitro: {}, root: rootDir }, "node-server", [], { provider: "openworkflow" })).cloudflare).toBeUndefined()
  }
  finally {
    await rm(rootDir, { force: true, recursive: true })
  }
})

it.each<{
  workflow: WorkflowOptions
  cloudflare: boolean
}>([
  { workflow: { provider: "cloudflare", binding: "FINAL" }, cloudflare: true },
  { workflow: false, cloudflare: false },
  { workflow: { provider: "openworkflow" }, cloudflare: false },
])("uses the Workflow options for Nitro: $workflow", async ({ workflow, cloudflare }) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-final-nitro-"))
  try {
    await mkdir(join(root, "server", "workflows"), { recursive: true })
    await writeFile(join(root, "server", "workflows", "welcome.ts"), "export default async () => 'ok'\n")
    let resolved: ResolvedConfig | undefined
    const nitro = await runConfigHook({ root }, "cloudflare-module", [{
      name: "application-resolved",
      enforce: "post",
      configResolved(config) { resolved = config },
    }], workflow)
    expect(nitro.cloudflare).toEqual(cloudflare ? {
      wrangler: { workflows: [expect.objectContaining({ binding: expect.stringContaining("FINAL") })] },
    } : undefined)
    expect(nitro.rollupConfig).toEqual(cloudflare ? expect.objectContaining({
      plugins: [expect.objectContaining({ name: "vitehub-workflow-cloudflare-exports" })],
    }) : undefined)
    if (!resolved) throw new TypeError("Expected resolved Vite config")
    generated.mockClear()
    await runProviderOutput(resolved)
    expect(generated).toHaveBeenCalledWith(expect.objectContaining({ cloudflareInNitro: cloudflare, workflow }), expect.any(Function))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it("keeps standalone Cloudflare output when Nitro is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-standalone-"))
  try {
    await mkdir(join(root, "server", "workflows"), { recursive: true })
    await writeFile(join(root, "server", "workflows", "welcome.ts"), "export default async () => 'ok'\n")
    const config = await resolveConfig({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [hubWorkflow({}, { hosting: "cloudflare-module" }), nitroOrderPlugins()],
    }, "build")
    generated.mockClear()
    await runProviderOutput(config)
    expect(generated).toHaveBeenCalledWith(expect.objectContaining({ cloudflareInNitro: false }), expect.any(Function))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
