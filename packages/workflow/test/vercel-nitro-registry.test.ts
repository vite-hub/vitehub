import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, expect, it, vi } from "vitest"
import { createWorld, setWorld } from "workflow/runtime"

import { generateWorkflowProviderOutputs } from "../src/internal/vite-build.ts"
import { hubWorkflow } from "../src/vite.ts"

import type { Plugin as EsbuildPlugin } from "esbuild"
import type { WorkflowOptions } from "../src/types.ts"

const packageDir = resolve(import.meta.dirname, "..")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createApp(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workflow-vercel-nitro-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), "{\"type\":\"module\"}\n")
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(resolve(root, file, ".."), { recursive: true })
    await writeFile(join(root, file), contents)
  }
  return root
}

type ConfigHook = (config: Record<string, unknown>, env: { command: "build", mode: string }) => Promise<unknown>

async function configureNitroVercelBuild(root: string, workflow: WorkflowOptions = {}) {
  const plugin = hubWorkflow(workflow, { hosting: "vercel" })
  const hook = plugin.config
  if (!hook || typeof hook === "function") throw new TypeError("Expected the hubWorkflow config hook to be an object hook.")
  const nitroPlugin = { name: "nitro:main" }
  const config: Record<string, unknown> = { nitro: { preset: "vercel" }, plugins: [nitroPlugin], root }
  await (hook.handler as unknown as ConfigHook)(config, { command: "build", mode: "production" })
  const nitroOptions: Record<string, unknown> = {}
  plugin.nitro?.setup({ options: nitroOptions })
  const resolvedConfig = { ...config, plugins: [plugin, nitroPlugin], resolve: { alias: [] } }
  await (plugin.configResolved as (config: unknown) => Promise<void>)(resolvedConfig)
  // SAFETY: The config hook adds its startup plugin to the Nitro config above.
  const [startupPlugin] = (config.nitro as { plugins: string[] }).plugins
  return { nitroOptions, plugin, startupPlugin: startupPlugin! }
}

const nitroServerStubs: EsbuildPlugin = {
  name: "nitro-server-stubs",
  setup(build) {
    build.onResolve({ filter: /^(?:nitro|@vercel\/functions)$/ }, args => ({ namespace: "stub", path: args.path }))
    build.onResolve({ filter: /^file:/ }, args => ({ path: fileURLToPath(args.path) }))
    build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({
      contents: args.path === "nitro"
        ? "export const definePlugin = plugin => plugin\n"
        : "export const waitUntil = promise => { globalThis.__vitehubWaitUntil.push(promise) }\n",
      loader: "js",
    }))
  },
}

it("runs and inspects a generated Workflow through Nitro and the Vercel DevKit flow", { timeout: 60_000 }, async () => {
  const root = await createApp({
    "server/workflows/welcome.ts": [
      "import { defineWorkflow } from '@vite-hub/workflow'",
      "",
      "export default defineWorkflow<string>({ handler: async ({ id, payload }) => payload === 'response'",
      "  ? new Response(id, { status: 201, headers: { 'x-workflow': 'welcome' } })",
      "  : { id, date: new Date(0), missing: undefined } })",
      "",
    ].join("\n"),
    "server/workflows/inline.ts": "import { createWorkflow } from '@vite-hub/workflow'\nexport default createWorkflow('inline', async () => 'inline')\n",
  })
  const { startupPlugin } = await configureNitroVercelBuild(root)

  const entry = join(root, "server-entry.mjs")
  await writeFile(entry, [
    `import startup from ${JSON.stringify(startupPlugin)}`,
    `import { getWorkflowRun, startWorkflow } from ${JSON.stringify(join(packageDir, "dist/index.js"))}`,
    "",
    "export async function start(name, payload) {",
    "  startup()",
    "  const [error, run] = await startWorkflow(name, payload)",
    "  if (error) throw error",
    "  return run",
    "}",
    "export async function inspect(id) {",
    "  const [error, run] = await getWorkflowRun('welcome', id)",
    "  if (error) throw error",
    "  return run",
    "}",
    "",
  ].join("\n"))
  const outfile = join(root, "server.mjs")
  await build({
    alias: { "@vite-hub/workflow": join(packageDir, "dist/index.js") },
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    logLevel: "silent",
    nodePaths: [join(packageDir, "node_modules")],
    outfile,
    platform: "node",
    plugins: [nitroServerStubs],
  })

  await generateWorkflowProviderOutputs({
    clientOutDir: join(root, "dist"),
    hosting: "vercel",
    nitroServer: true,
    providerImportAliases: { "@vite-hub/workflow": join(packageDir, "dist/index.js") },
    rootDir: root,
    workflow: {},
  })
  vi.stubEnv("WORKFLOW_TARGET_WORLD", "local")
  vi.stubEnv("WORKFLOW_LOCAL_DATA_DIR", join(root, "workflow-data"))
  const world = await createWorld()
  setWorld(world)
  Reflect.set(globalThis, "__vitehubWaitUntil", [])
  try {
    const flow = await import(pathToFileURL(join(root, ".vercel/output/functions/.well-known/workflow/v1/flow.func/index.mjs")).href)
    world.registerHandler?.("__wkf_workflow_", flow.POST)
    await world.start?.()
    const server = await import(pathToFileURL(outfile).href)
    await expect(server.start("inline")).rejects.toMatchObject({ code: "WORKFLOW_VERCEL_DISCOVERED_NOT_NATIVE" })
    const run = await server.start("welcome", "json")
    expect(run).toMatchObject({ id: expect.stringMatching(/^wrun_/), metadata: { workflow: "welcome" }, status: "queued" })
    expect(run.metadata).not.toHaveProperty("mode")
    expect(Reflect.get(globalThis, "__vitehubWaitUntil")).toHaveLength(0)
    const inspectCompleted = async (id: string) => await vi.waitFor(async () => {
      const stored = await server.inspect(id)
      expect(stored.status).toBe("completed")
      return stored.result
    }, { timeout: 10_000 })
    await expect(inspectCompleted(run.id)).resolves.toStrictEqual({ id: run.id, date: "1970-01-01T00:00:00.000Z" })
    const responseRun = await server.start("welcome", "response")
    const response = await inspectCompleted(responseRun.id)
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(201)
    expect(response.headers.get("x-workflow")).toBe("welcome")
    await expect(response.text()).resolves.toBe(responseRun.id)
  }
  finally {
    setWorld(undefined)
    await world.close?.()
    vi.unstubAllEnvs()
    Reflect.deleteProperty(globalThis, "__vitehubWaitUntil")
  }
})

it.each(["vite", "nitro"])("gives a native entry in %s the ID of the native Workflow build", async (pipeline) => {
  const definition = [
    "import { defineWorkflow } from '@vite-hub/workflow'",
    "",
    "async function durableOnboard() {",
    "  \"use workflow\"",
    "  return { ok: true }",
    "}",
    "",
    "export default defineWorkflow({ handler: async () => ({ ok: true }), native: durableOnboard })",
    "",
  ].join("\n")
  const root = await createApp({ "server/workflows/onboard.ts": definition })
  const { plugin, startupPlugin } = await configureNitroVercelBuild(root)

  const startup = await readFile(startupPlugin, "utf8")
  expect(startup).toContain("setVercelWorkflowRuntimeModules(workflowApi, workflowRuntime)")
  const transform = plugin.transform
  if (!transform || typeof transform === "function") throw new TypeError("Expected the hubWorkflow transform hook to be an object hook.")
  const context = pipeline === "vite" ? { environment: { config: { consumer: "server" } } } : {}
  const transformed = await transform.handler.call(context as never, definition, join(root, "server/workflows/onboard.ts"), { moduleType: "ts", ssr: pipeline === "nitro" })
  expect(transformed).toMatchObject({ code: expect.stringContaining("workflow//./server/workflows/onboard//durableOnboard") })
})

it("leaves Nitro's Vercel server function to Nitro", async () => {
  const root = await createApp({ "server/workflows/welcome.ts": "export default async () => 'ok'\n" })
  const outputRoot = join(root, ".vercel", "output")
  const nitroServer = join(outputRoot, "functions", "__server.func", "index.mjs")
  await mkdir(join(outputRoot, "functions", "__server.func"), { recursive: true })
  await writeFile(nitroServer, "export default 'nitro'\n")
  await writeFile(join(outputRoot, "config.json"), `${JSON.stringify({ routes: [{ dest: "/__server", src: "/(.*)" }], version: 3 })}\n`)

  await generateWorkflowProviderOutputs({ clientOutDir: join(root, "dist"), hosting: "vercel", nitroServer: true, rootDir: root, workflow: {} })

  await expect(readFile(nitroServer, "utf8")).resolves.toBe("export default 'nitro'\n")
  expect(existsSync(join(outputRoot, "functions", "__workflow.func"))).toBe(false)
  await expect(readFile(join(outputRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual({
    routes: [
      { dest: "/.well-known/workflow/v1/webhook/[token]", src: "^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$" },
      { dest: "/__server", src: "/(.*)" },
    ],
    version: 3,
  })
})

it("gives Nitro the Workflow DevKit webhook route of a native entry, because Nitro writes the Vercel config last", async () => {
  const native = [
    "import { defineWorkflow } from '@vite-hub/workflow'",
    "",
    "async function durableOnboard() {",
    "  \"use workflow\"",
    "  return { ok: true }",
    "}",
    "",
    "export default defineWorkflow({ handler: async () => ({ ok: true }), native: durableOnboard })",
    "",
  ].join("\n")
  const { nitroOptions } = await configureNitroVercelBuild(await createApp({ "server/workflows/onboard.ts": native }))

  expect(nitroOptions.vercel).toEqual({
    config: {
      routes: [{ dest: "/.well-known/workflow/v1/webhook/[token]", src: "^\\/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+)$" }],
    },
  })
})

it("adds no webhook route without a Workflow file, because only a native entry has a webhook function", async () => {
  const { nitroOptions } = await configureNitroVercelBuild(await createApp({ "server/routes/index.ts": "export default () => 'ok'\n" }))

  expect(nitroOptions.vercel).toBeUndefined()
})
