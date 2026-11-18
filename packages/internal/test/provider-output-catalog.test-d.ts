import { describe, it } from "vitest"

import {
  contributeCloudflareProviderOutput,
  contributeProviderRuntime,
  createProviderOutputCatalog,
  getProviderRuntimeModule,
} from "../src/build/provider-output-catalog.ts"

describe("Provider Output contribution catalog", () => {
  it("rejects unknown owners and provider kinds at the type boundary", () => {
    const catalog = createProviderOutputCatalog()
    // @ts-expect-error Env contributions cannot claim Queue fields.
    contributeCloudflareProviderOutput(catalog, { owner: "env", queues: {} })
    // @ts-expect-error Schedule does not contribute cross-product runtime modules.
    contributeProviderRuntime(catalog, { owner: "schedule", runtimeModules: {} })
    // @ts-expect-error Blob has no Netlify runtime module contribution.
    contributeProviderRuntime(catalog, { owner: "blob", runtimeModules: { netlify: "blob.mjs" } })
    // @ts-expect-error Database has no Deno runtime module contribution.
    getProviderRuntimeModule(catalog, "database", "deno")
  })
})
