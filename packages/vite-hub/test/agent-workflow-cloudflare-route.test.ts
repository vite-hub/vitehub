import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { Miniflare } from "miniflare"
import { createBuilder } from "vite"
import { afterAll, beforeAll, expect, it } from "vitest"

import { getCloudflareWorkflowBindingName } from "@vite-hub/workflow"
import { vitehub } from "vite-hub"

interface Wrangler {
  compatibility_flags?: string[]
  durable_objects: { bindings: Array<{ class_name: string, name: string }> }
  workflows?: Array<{ binding: string, class_name: string, name: string }>
}

/** The part of a Cloudflare Workflow binding that this test reads. */
interface WorkflowBinding {
  get(id: string): Promise<{ status(): Promise<{ error?: unknown, output?: unknown, status: string }> }>
}

const agent = (name: string, runtime?: string) => [
  `import { defineAgent${runtime ? ", agentWorkflow" : ""} } from "vite-hub/agent"`,
  "",
  "export default defineAgent({",
  ...(runtime ? [`  runtime: ${runtime},`] : []),
  // A Workflow Run returns JSON, so the Driver returns its reply instead of streaming it.
  `  driver: { run: () => "Hello from ${name}" },`,
  "})",
  "",
].join("\n")

let root: string
let worker: Miniflare
let wrangler: Wrangler

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-agent-workflow-route-"))
  await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
  await mkdir(join(root, "server/agents"), { recursive: true })
  await mkdir(join(root, "server/api"), { recursive: true })
  await writeFile(join(root, "server/agents/hello.ts"), agent("hello"))
  await writeFile(join(root, "server/agents/greeter.ts"), agent("greeter", "agentWorkflow(\"greeter\")"))
  await writeFile(join(root, "server/api/run.post.ts"), [
    "import { defineEventHandler, getQuery } from \"h3\"",
    "import { defineAgent, startAgentInvocation, agentWorkflow } from \"vite-hub/agent\"",
    "import { getRuntimeContext } from \"vite-hub/runtime\"",
    "import greeter from \"../agents/greeter\"",
    "import hello from \"../agents/hello\"",
    "",
    "// An Agent that the host did not discover, with the Workflow name of a discovered Agent.",
    "const impostor = defineAgent({ runtime: agentWorkflow(\"hello\"), driver: { run: () => \"Hello from impostor\" } })",
    "const agents = { greeter, hello, impostor }",
    "",
    "export default defineEventHandler(async (event) => {",
    "  const runtime = getRuntimeContext(event)",
    "  try {",
    "    const run = await startAgentInvocation(agents[getQuery(event).agent as keyof typeof agents], runtime, { prompt: \"ping\" })",
    "    return typeof run === \"object\" && run && \"id\" in run ? { id: run.id } : { inline: run }",
    "  }",
    "  catch (error) {",
    "    return { error: { code: (error as { code?: string }).code, message: (error as Error).message } }",
    "  }",
    "  finally {",
    "    await runtime.flushWaitUntil()",
    "  }",
    "})",
    "",
  ].join("\n"))
  const builder = await createBuilder({ logLevel: "silent", plugins: [vitehub({ host: "cloudflare", agent: true })], root })
  await builder.buildApp()

  const server = join(root, ".output/server")
  const files = (await readdir(server, { recursive: true })).filter(file => file.endsWith(".mjs"))
  wrangler = JSON.parse(await readFile(join(server, "wrangler.json"), "utf8")) as Wrangler
  worker = new Miniflare({
    // The build writes today's date. The pinned workerd binary can be older.
    compatibilityDate: "2026-04-20",
    compatibilityFlags: [...new Set([...wrangler.compatibility_flags ?? [], "nodejs_compat"])],
    durableObjects: Object.fromEntries(wrangler.durable_objects.bindings.map(item => [item.name, item.class_name])),
    // Wrangler uploads every chunk, so the Worker can import the lazy ones.
    modules: ["index.mjs", ...files.filter(file => file !== "index.mjs")].map(file => ({ path: join(server, file), type: "ESModule" as const })),
    modulesRoot: server,
    workflows: Object.fromEntries((wrangler.workflows ?? []).map(workflow => [workflow.binding, { className: workflow.class_name, name: workflow.name }])),
  })
}, 300_000)

afterAll(async () => {
  await worker?.dispose()
  await rm(root, { force: true, maxRetries: 3, recursive: true })
})

async function run(agentName: string): Promise<Record<string, unknown>> {
  const response = await worker.dispatchFetch(`http://localhost/api/run?agent=${agentName}`, { method: "POST" })
  const body = await response.text()
  expect(response.status, body).toBe(200)
  return JSON.parse(body) as Record<string, unknown>
}

it.each([
  ["hello", "a default Agent"],
  ["greeter", "an Agent with an agentWorkflow() binding"],
])("startAgentInvocation() from a route starts the discovered Workflow of %s (%s) in workerd", async (name) => {
  const started = await run(name)
  expect(started).toEqual({ id: expect.any(String) })

  // The route started the same Workflow that the Agent's own routes use.
  const binding = getCloudflareWorkflowBindingName(name)
  expect(wrangler.workflows?.map(workflow => workflow.binding)).toContain(binding)
  const instance = await (await worker.getBindings<Record<string, WorkflowBinding>>())[binding]!.get(started.id as string)
  await expect.poll(async () => (await instance.status()).status, { interval: 100, timeout: 60_000 }).toMatch(/^(?:complete|errored|terminated)$/)
  const status = await instance.status()
  expect({ error: status.error, status: status.status }).toEqual({ error: undefined, status: "complete" })
  // The Workflow stores the Agent's text reply as a portable Response.
  const output = status.output as { body?: { data?: string }, status?: number }
  expect(output.status).toBe(200)
  expect(Buffer.from(output.body?.data ?? "", "base64").toString()).toBe(`Hello from ${name}`)
}, 120_000)

it("rejects another Agent that uses the Workflow name of a discovered Agent", async () => {
  expect(await run("impostor")).toEqual({
    error: { code: "AGENT_R0422", message: expect.stringContaining("Workflow name \"hello\" belongs to a discovered Agent") },
  })
})
