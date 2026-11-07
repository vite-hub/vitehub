import { resolve } from "node:path"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { collectViteHubProviderOutputEntries } from "@vite-hub/internal/inspect"
import { expect, it } from "vitest"
import type { ResolvedConfig } from "vite"

import { hubWorkflow } from "../src/vite.ts"

it("inspects the published Cloudflare worker bundle", async () => {
  const plugin = hubWorkflow({ provider: "cloudflare" })

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
    const hook = plugin.config
    if (!hook || typeof hook === "function") throw new TypeError("Expected a config object hook")
    await hook.handler.call({} as never, { root }, { command: "build", mode: "production" })
    if (typeof plugin.configResolved !== "function") throw new TypeError("Expected a configResolved function hook")
    // SAFETY: This fixture provides the resolved fields read by the Workflow plugin.
    await plugin.configResolved.call({} as never, { root, build: {}, environments: {} } as ResolvedConfig)

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
