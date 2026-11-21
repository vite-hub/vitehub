import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { Miniflare } from "miniflare"
import { build, createNitro, prepare } from "nitro/builder"
import { expect, it } from "vitest"

const handler = fileURLToPath(new URL("./fixtures/emulate-production/check.ts", import.meta.url))

// A Cloudflare Worker sets no NODE_ENV, so the guard must read the build mode that Nitro writes into the bundle.
it("fails VITEHUB_MODELS=emulate in a production Worker without NODE_ENV", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-emulate-worker-"))
  try {
    const nitro = await createNitro({ dev: false, handlers: [{ handler, route: "/check" }], logLevel: 0, preset: "cloudflare-module", rootDir: root })
    try {
      await prepare(nitro)
      await build(nitro)
    }
    finally {
      await nitro.close()
    }
    const server = join(root, ".output/server")
    const modules = (await readdir(server, { recursive: true })).filter(file => file.endsWith(".mjs"))
    const worker = new Miniflare({
      bindings: { VITEHUB_MODELS: "emulate" },
      compatibilityDate: "2026-04-20",
      compatibilityFlags: ["nodejs_compat"],
      modules: ["index.mjs", ...modules.filter(file => file !== "index.mjs")].map(file => ({ path: join(server, file), type: "ESModule" as const })),
      modulesRoot: server,
    })
    try {
      const response = await worker.dispatchFetch("http://localhost/check")
      expect(await response.json()).toEqual({ code: "AGENT_MODELS_EMULATE_IN_PRODUCTION" })
    }
    finally {
      await worker.dispose()
    }
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}, 180_000)
