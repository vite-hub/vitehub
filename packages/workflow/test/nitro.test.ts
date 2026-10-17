import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

import { afterAll, expect, it } from "vitest"

import { createWorkflowNitroConfig } from "../src/internal/vite-build.ts"

interface ExportsPlugin {
  load: (id: string) => string | undefined
  name: string
  renderChunk: (code: string, chunk: { fileName: string, isEntry: boolean }) => { code: string } | null
  resolveId: (id: string) => string | undefined
}

const tempDirs: string[] = []

async function createProject(files: Record<string, string>) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-"))
  tempDirs.push(rootDir)
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(join(rootDir, file, ".."), { recursive: true })
    await writeFile(join(rootDir, file), contents)
  }
  return rootDir
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

it("leaves disabled Workflow out of the Nitro config", async () => {
  const nitro = { preset: "netlify" }
  await expect(createWorkflowNitroConfig({
    nitro,
    rootDir: "/tmp/unused",
    workflow: false,
  })).resolves.toBe(nitro)
})

it("installs the Workflow registry with a Nitro plugin and middleware on every host", async () => {
  const rootDir = await createProject({ "server/workflows/welcome.ts": "export default defineWorkflow(async () => 'ok')\n" })

  const nitro = await createWorkflowNitroConfig({ nitro: { preset: "node-server" }, rootDir, workflow: {} })

  expect(nitro.plugins).toEqual([join(rootDir, ".vitehub/workflow/nitro-plugin.mjs")])
  expect(nitro.handlers).toEqual([{ handler: join(rootDir, ".vitehub/workflow/nitro-middleware.mjs"), middleware: true, route: "/**" }])
  expect(nitro.modules).toBeUndefined()
  expect(nitro.cloudflare).toBeUndefined()
})

it("adds the Vercel Workflow Nitro module for native Workflows", async () => {
  const rootDir = await createProject({ "server/workflows/onboard/01-greet.ts": "export default async function greet(input) { return input }\n" })

  const nitro = await createWorkflowNitroConfig({ nitro: { preset: "vercel" }, rootDir, vite: true, workflow: {} })

  expect(nitro.modules).toEqual([
    expect.objectContaining({ name: "vitehub:workflow-package-link" }),
    expect.objectContaining({ name: "workflow/nitro" }),
  ])
  expect(nitro.workflow).toEqual({
    _vite: true,
    dirs: [join(rootDir, "server/workflows"), join(rootDir, ".vitehub/workflow/vercel-native")],
  })
})

it("installs discovered Agent workflows into a Cloudflare Nitro entry", async () => {
  const rootDir = await createProject({ "server/agents/calories/agent.ts": "export default defineAgent({ driver: { run: () => 'ok' } })\n" })

  const nitro = await createWorkflowNitroConfig({
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
  const plugin = (nitro.rollupConfig as { plugins: ExportsPlugin[] }).plugins
    .find(candidate => candidate.name === "vitehub-workflow-cloudflare-exports")!
  const moduleId = plugin.resolveId("virtual:vitehub-workflow-cloudflare-exports")!
  expect(plugin.load(moduleId)).toContain(`from ${JSON.stringify(join(rootDir, ".vitehub/workflow/cloudflare-workflows.mjs"))}`)
  const workflowFile = join(rootDir, "server/agents/calories/agent.ts")
  expect(plugin.resolveId(pathToFileURL(workflowFile).href)).toBe(workflowFile)
  expect(plugin.renderChunk("export default {}", { fileName: "index.js", isEntry: true })).toMatchObject({
    code: expect.stringMatching(/export \{ ViteHub.*Workflow \} from '\.\/workflow-cloudflare-exports\.mjs'/),
  })
  expect(plugin.renderChunk("export default {}", { fileName: "other.js", isEntry: true })).toBeNull()

  const again = await createWorkflowNitroConfig({ nitro, rootDir, workflow: {} })
  // SAFETY: Cloudflare configuration creation above installs the Rollup plugins array.
  expect((again.rollupConfig as { plugins: ExportsPlugin[] }).plugins).toHaveLength(1)
  expect(again.plugins).toHaveLength(1)
})
