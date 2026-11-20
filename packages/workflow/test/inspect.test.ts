import { resolve } from "node:path"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { collectViteHubProviderOutputEntries, collectViteHubResourceSummaries } from "@vite-hub/internal/inspect"
import { expect, it } from "vitest"
import { resolveConfig } from "vite"

import { createCloudflareWorkflowNitroConfig } from "../src/internal/vite-build.ts"
import { hubWorkflow } from "../src/vite.ts"
import { nitroOrderPlugins } from "../../vite-hub/src/nitro-order.ts"

it("inspects the published Cloudflare worker bundle", async () => {
  const plugin = hubWorkflow({ driver: "cloudflare" })

  expect(await collectViteHubProviderOutputEntries([plugin])).toEqual([{
    description: "Generated Cloudflare Workflow worker",
    owner: "workflow",
    path: resolve(createDefaultCloudflareOutputRoot(process.cwd()), "worker.mjs"),
  }])
})

it("inspects Nitro's Wrangler config when it owns the Cloudflare Workflows", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "vitehub-workflow-inspect-nitro-"))
  try {
    await mkdir(resolve(root, "server", "workflows"), { recursive: true })
    await writeFile(resolve(root, "server", "workflows", "welcome.ts"), "export default defineWorkflow(async () => 'ok')\n")
    const plugin = hubWorkflow({}, { hosting: "cloudflare-module" })
    await resolveConfig({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin, { name: "nitro:init", config() {} }, nitroOrderPlugins()],
    }, "build")

    expect(await collectViteHubProviderOutputEntries([plugin])).toEqual([{
      description: "Cloudflare Workflow bindings in Nitro's Wrangler config",
      owner: "workflow",
      path: resolve(createDefaultCloudflareOutputRoot(root), "wrangler.json"),
    }])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

it.each([
  [{ driver: "cloudflare" as const }],
  [{ binding: "WELCOME", driver: "cloudflare" as const, name: "welcome-flow" }],
])("lists the Cloudflare Workflows that the build binds, for %j", async (workflow) => {
  const root = await mkdtemp(resolve(tmpdir(), "vitehub-workflow-resources-"))
  try {
    await mkdir(resolve(root, "server", "workflows"), { recursive: true })
    await writeFile(resolve(root, "server", "workflows", "welcome.ts"), "export default defineWorkflow(async () => 'ok')\n")
    const plugin = hubWorkflow(workflow)
    await resolveConfig({ root, configFile: false, logLevel: "silent", plugins: [plugin] }, "build")

    const resources = await collectViteHubResourceSummaries([plugin])
    const nitro = await createCloudflareWorkflowNitroConfig({ nitro: { preset: "cloudflare-module" }, rootDir: root, workflow })
    const workflows = (nitro.cloudflare as { wrangler: { workflows: { binding: string, class_name: string, name: string }[] } }).wrangler.workflows
    expect(resources).toEqual(workflows.map(entry => ({
      binding: entry.binding,
      definition: "welcome",
      host: "cloudflare",
      kind: "cloudflare-workflow",
      name: entry.name,
      note: `The Worker exports the class ${entry.class_name}.`,
      owner: "workflow",
      source: "name",
    })))
    if ("binding" in workflow) expect(resources).toMatchObject([{ binding: "WELCOME", name: "welcome-flow" }])
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

it("lists no Cloudflare Workflows for another driver", async () => {
  const plugin = hubWorkflow({ driver: "vercel" })
  expect(await collectViteHubResourceSummaries([plugin])).toEqual([])
})
