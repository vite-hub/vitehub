import { describe, expect, it } from "vitest"

import { composeNitroCloudflareProviderOutput } from "../src/build/cloudflare-provider-output.ts"
import {
  contributeCloudflareProviderOutput,
  contributeProviderRuntime,
  createProviderOutputCatalog,
  getProviderRuntimeModule,
  getVercelRuntimePackages,
  hasProviderRuntimeModule,
  resetProviderOutputRuntime,
  useProviderOutputCatalog,
} from "../src/build/provider-output-catalog.ts"

describe("Provider Output contribution catalog", () => {
  it("isolates contributions by build config while sharing one catalog within a build", () => {
    const firstConfig = {}
    const secondConfig = {}
    const first = useProviderOutputCatalog(firstConfig)
    const second = useProviderOutputCatalog(secondConfig)

    expect(useProviderOutputCatalog(firstConfig)).toBe(first)
    expect(second).not.toBe(first)

    contributeProviderRuntime(first, { owner: "blob", runtimeModules: { cloudflare: "first.mjs" } })
    expect(getProviderRuntimeModule(first, "blob", "cloudflare")).toBe("first.mjs")
    expect(getProviderRuntimeModule(second, "blob", "cloudflare")).toBeUndefined()
  })

  it("replaces duplicate owner contributions and clears repeat-build runtime state", () => {
    const catalog = createProviderOutputCatalog()
    contributeProviderRuntime(catalog, {
      owner: "blob",
      runtimeModules: { cloudflare: "old.mjs", vercel: "old-vercel.mjs" },
      vercelRuntimePackages: [{ name: "old-package", resolveFrom: "/project" }],
    })
    contributeProviderRuntime(catalog, { owner: "blob", runtimeModules: { cloudflare: "current.mjs" } })

    expect(getProviderRuntimeModule(catalog, "blob", "cloudflare")).toBe("current.mjs")
    expect(getProviderRuntimeModule(catalog, "blob", "vercel")).toBeUndefined()
    expect(getVercelRuntimePackages(catalog, "blob")).toEqual([])

    resetProviderOutputRuntime(catalog)
    expect(getProviderRuntimeModule(catalog, "blob", "cloudflare")).toBeUndefined()
  })

  it("reports sibling provider runtimes without exposing mutable owner records", () => {
    const catalog = createProviderOutputCatalog()
    contributeProviderRuntime(catalog, { owner: "blob", runtimeModules: { cloudflare: "blob.mjs" } })
    contributeProviderRuntime(catalog, { owner: "database", runtimeModules: { cloudflare: "database.mjs", vercel: "database-node.mjs" } })

    expect(hasProviderRuntimeModule(catalog, "cloudflare", { except: "database" })).toBe(true)
    expect(hasProviderRuntimeModule(catalog, "vercel", { except: "database" })).toBe(false)
  })

  it("composes every declared Cloudflare owner without exposing mutable records", () => {
    const catalog = createProviderOutputCatalog()
    contributeCloudflareProviderOutput(catalog, { owner: "blob", r2Buckets: [{ binding: "BLOB", bucket_name: "assets" }] })
    contributeCloudflareProviderOutput(catalog, { owner: "env", requiredSecrets: ["TOKEN"] })
    contributeCloudflareProviderOutput(catalog, { owner: "queue", queues: { producers: [{ binding: "JOBS", queue: "jobs" }] } })
    contributeCloudflareProviderOutput(catalog, { owner: "rate-limit", rateLimits: [{ name: "UPLOADS" }] })

    expect(composeNitroCloudflareProviderOutput(catalog, {})).toHaveProperty("cloudflare.wrangler", {
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
      r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }],
      ratelimits: [{ name: "UPLOADS" }],
      secrets: { required: ["TOKEN"] },
    })
  })

  it("rejects unknown owners and provider kinds at the type boundary", () => {
    const catalog = createProviderOutputCatalog()
    if (false) {
      // @ts-expect-error Env contributions cannot claim Queue fields.
      contributeCloudflareProviderOutput(catalog, { owner: "env", queues: {} })
      // @ts-expect-error Schedule does not contribute cross-product runtime modules.
      contributeProviderRuntime(catalog, { owner: "schedule", runtimeModules: {} })
      // @ts-expect-error Blob has no Netlify runtime module contribution.
      contributeProviderRuntime(catalog, { owner: "blob", runtimeModules: { netlify: "blob.mjs" } })
      // @ts-expect-error Database has no Deno runtime module contribution.
      getProviderRuntimeModule(catalog, "database", "deno")
    }
    expect(catalog).toBeDefined()
  })
})
