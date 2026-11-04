import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { expect, it } from "vitest"
import { createSandboxTaskFeaturePlan } from "../../src/task/feature.ts"

// workerd allows `new Function` while a Worker starts but not during a request, which is when Nitro loads route chunks.
it("loads the generated Cloudflare provider loader during a Workers request", async () => {
  const plan = await createSandboxTaskFeaturePlan({ provider: "cloudflare" }, [], { aliasPath: "/tmp/vitehub-sandbox-task/index.js" }, {})
  const loader = plan.artifacts?.find(artifact => artifact.key === "sandbox-task-provider-loader")?.contents ?? ""
  const bundle = await build({
    bundle: true,
    conditions: ["workerd", "worker"],
    external: ["cloudflare:*", "node:*"],
    format: "esm",
    platform: "neutral",
    stdin: { contents: loader, resolveDir: import.meta.dirname },
    write: false,
  })
  const worker = new Miniflare({
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    modules: [
      {
        type: "ESModule",
        path: "worker.mjs",
        contents: `export default {
          async fetch() {
            const { loadSandboxTaskRuntimeProvider } = await import("./loader.mjs")
            const error = await loadSandboxTaskRuntimeProvider("vercel").catch(error => error)
            return new Response(error.message)
          },
        }`,
      },
      { type: "ESModule", path: "loader.mjs", contents: bundle.outputFiles![0]!.text },
    ],
  })
  try {
    const response = await worker.dispatchFetch("https://example.com/")
    await expect(response.text()).resolves.toBe("[vitehub] Unsupported sandbox provider for this hosted build: vercel")
  }
  finally {
    await worker.dispose()
  }
}, 30_000)
