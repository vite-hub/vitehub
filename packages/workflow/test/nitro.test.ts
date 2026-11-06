import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

import { expect, it } from "vitest"

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"

import { createCloudflareWorkflowNitroConfig } from "../src/internal/vite-build.ts"
import { hubWorkflow } from "../src/vite.ts"

it("leaves implicit Workflow disabled for Netlify Nitro output", async () => {
  const nitro = { preset: "netlify" }
  await expect(createCloudflareWorkflowNitroConfig({
    nitro,
    rootDir: "/tmp/unused",
    workflow: undefined,
  })).resolves.toBe(nitro)
})

it("installs discovered Agent workflows into a Cloudflare Nitro entry", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workflow-nitro-"))
  try {
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
    const moduleId = plugin.resolveId("virtual:vitehub-workflow-cloudflare-exports")
    expect(plugin.load(moduleId)).toContain("installViteHubWorkflowRuntime()")
    const workflowFile = join(agentDir, "agent.ts")
    expect(plugin.resolveId(pathToFileURL(workflowFile).href)).toBe(workflowFile)
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

type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<unknown>

async function runConfigHook(config: Record<string, unknown>, hosting: string): Promise<Record<string, unknown>> {
  const hook = hubWorkflow({}, { hosting }).config
  if (!hook || typeof hook === "function") throw new TypeError("Expected the hubWorkflow config hook to be an object hook.")
  await (hook.handler as unknown as ConfigHook)(config, { command: "build", mode: "production" })
  // SAFETY: The config hook writes the Nitro config object back to `config.nitro`.
  return config.nitro as Record<string, unknown>
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
    const nuxt = await runConfigHook({ nitro: {}, root: rootDir, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }, "cloudflare-module")
    expect(nuxt.cloudflare).toBeUndefined()
    expect((await runConfigHook({ nitro: {}, root: rootDir }, "node-server")).cloudflare).toBeUndefined()
  }
  finally {
    await rm(rootDir, { force: true, recursive: true })
  }
})
