import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Miniflare } from "miniflare"
import { build } from "vite"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { seal, unseal } from "../src/index.ts"

const root = "workers-seal-root-secret-at-least-32-characters"
// The published runtime, bundled the way a Workers build bundles it: worker conditions, Node builtins left to nodejs_compat.
async function bundleWorker(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vitehub-seal-worker-"))
  try {
    const entry = join(dir, "worker.mjs")
    await writeFile(entry, `
      import { seal, unseal } from ${JSON.stringify(fileURLToPath(new URL("../dist/index.js", import.meta.url)))}
      import { runWithCloudflareEnv } from ${JSON.stringify(fileURLToPath(new URL("../dist/internal/server.js", import.meta.url)))}
      export default {
        async fetch(request, env) {
          const { action, purpose, sealed, value } = await request.json()
          return await runWithCloudflareEnv(env, async () => {
            if (action === "seal") return Response.json({ sealed: await seal(purpose, value, { ttl: 60 }) })
            const [error, data] = await unseal(purpose, sealed)
            return Response.json({ code: error?.code, data })
          })
        },
      }
    `)
    const output = await build({
      configFile: false,
      logLevel: "silent",
      root: dir,
      resolve: { conditions: ["workerd", "worker", "import", "default"] },
      ssr: { noExternal: true, target: "webworker" },
      build: {
        minify: false,
        rolldownOptions: { external: [/^node:/, /^cloudflare:/], output: { codeSplitting: false } },
        ssr: entry,
        write: false,
      },
    })
    const [result] = Array.isArray(output) ? output : [output]
    if (!result || !("output" in result)) throw new Error("Vite did not return a bundle.")
    const chunk = result.output.find(item => item.type === "chunk" && item.isEntry)
    if (chunk?.type !== "chunk") throw new Error("Vite did not return an entry chunk.")
    return chunk.code
  }
  finally {
    await rm(dir, { force: true, recursive: true })
  }
}

describe("seal across Node and Workers", () => {
  let worker: Miniflare

  beforeAll(async () => {
    worker = new Miniflare({
      bindings: { VITEHUB_SECRET: root },
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ type: "ESModule", path: "worker.mjs", contents: await bundleWorker() }],
    })
  }, 60_000)

  afterAll(async () => {
    await worker?.dispose()
  })

  async function call(body: object): Promise<{ code?: string, data?: unknown, sealed?: string }> {
    const response = await worker.dispatchFetch("https://worker.test/", { body: JSON.stringify(body), method: "POST" })
    expect(response.status).toBe(200)
    return await response.json() as { code?: string, data?: unknown, sealed?: string }
  }

  it("opens on Workers what Node sealed, and the other way round", async () => {
    vi.stubEnv("VITEHUB_SECRET", root)
    const value = { userId: "u_1", note: "Café 🌍" }

    const fromNode = await seal("app:upload", value, { ttl: 60 })
    expect(await call({ action: "unseal", purpose: "app:upload", sealed: fromNode })).toEqual({ data: value })

    const { sealed: fromWorkers } = await call({ action: "seal", purpose: "app:upload", value })
    expect(await unseal("app:upload", fromWorkers!)).toEqual([undefined, value])

    expect(await call({ action: "unseal", purpose: "app:choice", sealed: fromNode })).toEqual({ code: "ENV_SEAL_WRONG_PURPOSE" })
    vi.unstubAllEnvs()
  }, 30_000)
})
