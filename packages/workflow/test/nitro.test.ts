import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, it } from "vitest"

import { createCloudflareWorkflowNitroConfig } from "../src/internal/vite-build.ts"

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
    expect((nitro.cloudflare as { wrangler: { workflows: unknown[] } }).wrangler.workflows).toEqual([
      expect.objectContaining({ class_name: expect.stringContaining("Calories"), name: expect.stringContaining("63616c6f72696573") }),
      expect.objectContaining({ class_name: expect.stringContaining("InvocationRecoveryCalories") }),
    ])
    expect((nitro.rollupConfig as { plugins: Array<{ name: string }> }).plugins).toContainEqual(
      expect.objectContaining({ name: "vitehub-workflow-cloudflare-exports" }),
    )
    const plugin = (nitro.rollupConfig as { plugins: Array<Record<string, any>> }).plugins
      .find(candidate => candidate.name === "vitehub-workflow-cloudflare-exports")!
    const moduleId = plugin.resolveId("virtual:vitehub-workflow-cloudflare-exports")
    expect(plugin.load(moduleId)).toContain("installViteHubWorkflowRuntime()")
    const renderChunk = typeof plugin.renderChunk === "function" ? plugin.renderChunk : plugin.renderChunk.handler
    expect(renderChunk.call({}, "export default {}", { fileName: "index.js", isEntry: true })).toMatchObject({
      code: expect.stringMatching(/export \{ ViteHub.*Workflow \} from '\.\/workflow-cloudflare-exports\.mjs'/),
    })
    expect(renderChunk.call({}, "export default {}", { fileName: "other.js", isEntry: true })).toBeNull()
  }
  finally {
    await rm(rootDir, { force: true, recursive: true })
  }
})
