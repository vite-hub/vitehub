import { resolve } from "node:path"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { collectViteHubProviderOutputEntries } from "@vite-hub/internal/inspect"
import { expect, it } from "vitest"

import { hubWorkflow } from "../src/vite.ts"

it("inspects the published Cloudflare worker bundle", async () => {
  const plugin = hubWorkflow({ provider: "cloudflare" })

  expect(await collectViteHubProviderOutputEntries([plugin])).toEqual([{
    description: "Generated Cloudflare Workflow worker",
    owner: "workflow",
    path: resolve(createDefaultCloudflareOutputRoot(process.cwd()), "worker.mjs"),
  }])
})
