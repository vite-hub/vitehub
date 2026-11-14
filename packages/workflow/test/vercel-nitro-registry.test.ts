import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"
import { afterEach, expect, it } from "vitest"

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

/** Runs the config hooks of a `vitehub({ host: "vercel" })` build with `nitro()`, as Vite does. */
async function configureNitroVercelBuild(root: string, workflow: WorkflowOptions = {}) {
  const plugin = hubWorkflow(workflow, { hosting: "vercel" })
  const hook = plugin.config
  if (!hook || typeof hook === "function") throw new TypeError("Expected the hubWorkflow config hook to be an object hook.")
  const nitroPlugin = { name: "nitro:main" }
  const config: Record<string, unknown> = { nitro: { preset: "vercel" }, plugins: [nitroPlugin], root }
  await (hook.handler as unknown as ConfigHook)(config, { command: "build", mode: "production" })
  const resolvedConfig = { ...config, plugins: [plugin, nitroPlugin], resolve: { alias: [] } }
  await (plugin.configResolved as (config: unknown) => Promise<void>)(resolvedConfig)
  // SAFETY: The config hook adds its startup plugin to the Nitro config above.
  const [startupPlugin] = (config.nitro as { plugins: string[] }).plugins
  return { plugin, startupPlugin: startupPlugin! }
}

const nitroServerStubs: EsbuildPlugin = {
  name: "nitro-server-stubs",
  setup(build) {
    build.onResolve({ filter: /^(?:nitro|@vercel\/functions)$/ }, args => ({ namespace: "stub", path: args.path }))
    // The registry imports definitions by file URL, which Vite resolves.
    build.onResolve({ filter: /^file:/ }, args => ({ path: fileURLToPath(args.path) }))
    build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({
      contents: args.path === "nitro"
        ? "export const definePlugin = plugin => plugin\n"
        : "export const waitUntil = promise => { globalThis.__vitehubWaitUntil.push(promise) }\n",
      loader: "js",
    }))
  },
}

it("installs the Workflow registry in Nitro's Vercel server function", async () => {
  const root = await createApp({
    "server/workflows/welcome.ts": [
      "import { defineWorkflow } from '@vite-hub/workflow'",
      "",
      "export default defineWorkflow('welcome', async (payload: { name: string }) => ({ greeting: `Hello ${payload.name}` }))",
      "",
    ].join("\n"),
  })
  const { startupPlugin } = await configureNitroVercelBuild(root)

  // Nitro bundles its startup plugin with the routes. A route then starts the Workflow in the same process.
  const entry = join(root, "server-entry.mjs")
  await writeFile(entry, [
    `import startup from ${JSON.stringify(startupPlugin)}`,
    `import { getWorkflowRun, startWorkflow } from ${JSON.stringify(join(packageDir, "dist/index.js"))}`,
    "",
    "export async function handleRequest() {",
    "  startup()",
    "  const run = await startWorkflow('welcome', { name: 'Ada' })",
    "  await Promise.all(globalThis.__vitehubWaitUntil)",
    "  return { run, settled: await getWorkflowRun('welcome', run.id) }",
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

  Reflect.set(globalThis, "__vitehubWaitUntil", [])
  try {
    const server = await import(pathToFileURL(outfile).href) as { handleRequest: () => Promise<{ run: { id: string, status: string }, settled: { result: unknown, status: string } }> }
    const { run, settled } = await server.handleRequest()
    expect(run.status).toBe("queued")
    // The inline run keeps the function alive through `waitUntil` until it settles.
    expect(Reflect.get(globalThis, "__vitehubWaitUntil")).toHaveLength(1)
    expect(settled.status).toBe("completed")
    expect(settled.result).toBeInstanceOf(Response)
    await expect((settled.result as Response).json()).resolves.toEqual({ greeting: "Hello Ada" })
  }
  finally {
    Reflect.deleteProperty(globalThis, "__vitehubWaitUntil")
  }
})

it("gives a native entry in Nitro's server bundle the ID of the native Workflow build", async () => {
  const definition = [
    "import { defineWorkflow } from '@vite-hub/workflow'",
    "",
    "async function durableOnboard() {",
    "  \"use workflow\"",
    "  return { ok: true }",
    "}",
    "",
    "export default defineWorkflow('onboard', async () => ({ ok: true }), { native: durableOnboard })",
    "",
  ].join("\n")
  const root = await createApp({ "server/workflows/onboard.ts": definition })
  const { plugin, startupPlugin } = await configureNitroVercelBuild(root)

  const startup = await readFile(startupPlugin, "utf8")
  expect(startup).toContain("setVercelWorkflowRuntimeModules(workflowApi, workflowRuntime)")
  const transform = plugin.transform
  if (!transform || typeof transform === "function") throw new TypeError("Expected the hubWorkflow transform hook to be an object hook.")
  const context = { environment: { config: { consumer: "server" } } }
  const transformed = await transform.handler.call(context as never, definition, join(root, "server/workflows/onboard.ts"))
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
  await expect(readFile(join(outputRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual({ routes: [{ dest: "/__server", src: "/(.*)" }], version: 3 })
})
