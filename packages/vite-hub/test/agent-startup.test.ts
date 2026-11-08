import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { Miniflare } from "miniflare"
import { createBuilder } from "vite"
import { expect, it } from "vitest"

import { vitehub } from "vite-hub"

/** The source of every output file that `file` imports statically, as a Worker loads them at startup. */
async function startupSources(file: string, seen = new Map<string, string>()): Promise<Map<string, string>> {
  if (seen.has(file)) return seen
  const source = await readFile(file, "utf8")
  seen.set(file, source)
  const imports = [...source.matchAll(/^(?:import|export)\b[^;"']*?["'](\.{1,2}\/[^"']+)["']/gm)].map(match => match[1]!)
  for (const path of imports) await startupSources(resolve(dirname(file), path), seen)
  return seen
}

/** The modules that Rolldown wrote into `sources`, from its `//#region <module>` comments. */
function bundledModules(sources: Iterable<string>): string[] {
  return [...sources].flatMap(source => [...source.matchAll(/^\/\/#region (.+)$/gm)].map(match => match[1]!))
}

interface CloudflareAgentApp {
  files: string[]
  /** Every module in the server output. */
  output: string[]
  root: string
  server: string
  /** The modules that the Worker entry loads at startup. */
  startup: string[]
  wrangler: {
    compatibility_flags?: string[]
    durable_objects: { bindings: Array<{ class_name: string, name: string }> }
    workflows?: Array<{ binding: string, class_name: string, name: string }>
  }
}

/** The part of a Cloudflare Workflow binding that this test reads. */
interface WorkflowBinding {
  create(options: { id: string, params: unknown }): Promise<{ status(): Promise<{ error?: unknown, output?: unknown, status: string }> }>
}

/**
 * Build an app with one Agent for Cloudflare. `runtime` is the source of the Agent's `runtime` option, if any.
 * `driver` is the source of its `run` Driver.
 */
async function buildCloudflareAgentApp({ driver, runtime }: { driver: string[], runtime?: string }): Promise<CloudflareAgentApp> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-startup-"))
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await mkdir(join(root, "server/agents"), { recursive: true })
  await writeFile(join(root, "server/agents/hello.ts"), [
    "import { defineAgent } from \"vite-hub/agent\"",
    "import { webChat } from \"vite-hub/agent/channels\"",
    "",
    "export default defineAgent({",
    "  channels: { web: webChat() },",
    ...(runtime ? [`  runtime: ${runtime},`] : []),
    "  driver: {",
    ...driver.map(line => `    ${line}`),
    "  },",
    "})",
    "",
  ].join("\n"))
  const builder = await createBuilder({ logLevel: "silent", plugins: [vitehub({ host: "cloudflare", agent: true })], root })
  await builder.buildApp()

  const server = join(root, ".output/server")
  const files = (await readdir(server, { recursive: true })).filter(file => file.endsWith(".mjs"))
  return {
    files,
    output: bundledModules(await Promise.all(files.map(file => readFile(join(server, file), "utf8")))),
    root,
    server,
    startup: bundledModules((await startupSources(join(server, "index.mjs"))).values()),
    wrangler: JSON.parse(await readFile(join(server, "wrangler.json"), "utf8")) as CloudflareAgentApp["wrangler"],
  }
}

/** Run the built Worker in workerd. Wrangler uploads every file that its `rules` match, so the Worker can import the lazy chunks. */
function startWorker(app: CloudflareAgentApp): Miniflare {
  return new Miniflare({
    // The build writes today's date. The pinned workerd binary can be older.
    compatibilityDate: "2026-04-20",
    compatibilityFlags: [...new Set([...app.wrangler.compatibility_flags ?? [], "nodejs_compat"])],
    durableObjects: Object.fromEntries(app.wrangler.durable_objects.bindings.map(binding => [binding.name, binding.class_name])),
    modules: ["index.mjs", ...app.files.filter(file => file !== "index.mjs")].map(file => ({ path: join(app.server, file), type: "ESModule" as const })),
    modulesRoot: app.server,
    workflows: Object.fromEntries((app.wrangler.workflows ?? []).map(workflow => [workflow.binding, { className: workflow.class_name, name: workflow.name }])),
  })
}

async function chat(worker: Miniflare): Promise<Response> {
  return await worker.dispatchFetch("http://localhost/api/_vitehub/agents/hello/chat", {
    body: JSON.stringify({ id: "startup", messages: [{ id: "user-1", parts: [{ text: "ping", type: "text" }], role: "user" }] }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

const definition = /\/server\/agents\/hello\.ts$/
const routes = /\/\.vitehub\/agent\/chat-webhook-route\.ts$/
const workspace = /workspace\/dist\//

it("loads the Agent routes and Agent Definitions on the first request, not at Worker startup", async () => {
  // An Agent that runs as a Workflow also loads through the Cloudflare Workflow classes. The next test covers them.
  const app = await buildCloudflareAgentApp({
    driver: [
      "async *run() {",
      "  yield { type: \"text-delta\" as const, text: \"Hello from the Agent\" }",
      "  yield { type: \"finish\" as const }",
      "},",
    ],
    runtime: "false",
  })
  let worker: Miniflare | undefined
  try {
    expect(app.output).toContainEqual(expect.stringMatching(definition))
    expect(app.output).toContainEqual(expect.stringMatching(routes))
    expect(app.startup).toContainEqual(expect.stringMatching(/agent\/dist\/cloudflare\/state\.js$/))
    expect(app.startup.filter(module => definition.test(module) || routes.test(module))).toEqual([])
    // The Agent routes import the Workspace runtime. Nothing else at startup does.
    expect(app.output).toContainEqual(expect.stringMatching(workspace))
    expect(app.startup.filter(module => workspace.test(module))).toEqual([])

    worker = startWorker(app)
    const response = await chat(worker)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Hello from the Agent")
  }
  finally {
    await worker?.dispose()
    await rm(app.root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)

it("loads the Agent runtime of a Workflow Agent on its first run, not when the Worker exports the Workflow classes", async () => {
  // A Workflow Run returns JSON, so this Driver returns its reply instead of streaming it.
  const app = await buildCloudflareAgentApp({ driver: ["run: () => \"Hello from the Agent\","] })
  let worker: Miniflare | undefined
  try {
    expect(app.wrangler.workflows?.length).toBeGreaterThan(0)
    expect(app.startup).toContainEqual(expect.stringMatching(/virtual:vitehub-workflow-cloudflare-exports$/))
    // The Workflow registry runtime holds the Agent setup and the Definition loaders.
    const registryRuntime = /\/\.vitehub\/workflow\/registry-runtime\.mjs$/
    const agentWorkflowRuntime = /agent\/dist\/runtime\/workflow\.js$/
    const lazy = [definition, routes, registryRuntime, agentWorkflowRuntime, workspace]
    expect(app.startup.filter(module => lazy.some(pattern => pattern.test(module)))).toEqual([])
    for (const pattern of lazy) expect(app.output).toContainEqual(expect.stringMatching(pattern))

    // Run the Agent's Workflow as Cloudflare runs it: the Worker's exported class loads the registry runtime and the Agent.
    worker = startWorker(app)
    const binding = app.wrangler.workflows?.find(workflow => !workflow.class_name.includes("InvocationRecovery"))?.binding
    if (!binding) throw new Error("Expected the Agent's Workflow binding.")
    const workflows = await worker.getBindings<Record<string, WorkflowBinding>>()
    const instance = await workflows[binding]!.create({ id: "startup", params: { input: { prompt: "ping" } } })
    await expect.poll(async () => (await instance.status()).status, { interval: 100, timeout: 60_000 }).toMatch(/^(?:complete|errored|terminated)$/)
    const status = await instance.status()
    expect({ error: status.error, status: status.status }).toEqual({ error: undefined, status: "complete" })
    // The Workflow stores the Agent's text reply as a portable Response.
    const output = status.output as { body?: { data?: string }, status?: number }
    expect(output.status).toBe(200)
    expect(Buffer.from(output.body?.data ?? "", "base64").toString()).toBe("Hello from the Agent")
  }
  finally {
    await worker?.dispose()
    await rm(app.root, { force: true, recursive: true, maxRetries: 3 })
  }
}, 300_000)
