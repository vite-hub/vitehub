import { resolve } from "node:path"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { collectViteHubProviderOutputEntries } from "@vite-hub/internal/inspect"
import { expect, it } from "vitest"
import { resolveConfig } from "vite"

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
