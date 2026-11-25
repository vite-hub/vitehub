import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

// Generated server modules import the built package, so the test uses the same module graph.
import viteHubNuxt from "vite-hub/nuxt"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { buildNitro, createNuxt, nuxtFixture } from "./support/nuxt-nitro-build.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const ci = await consoleTestKey("CI")
const publicUrl = "http://app.example.com"

describe("Signed Console calls in Nuxt with a separate Nitro build", () => {
  it("gives the Nitro config the configured public URL in development", async () => {
    const { app, root } = await nuxtFixture()
    try {
      const { nitroConfig, nuxt } = createNuxt(app, true)
      await viteHubNuxt({ console: true, env: false, host: "node", publicUrl }, nuxt)
      const config = await nitroConfig()
      expect(config.replace).toMatchObject({ __VITEHUB_PUBLIC_URL__: JSON.stringify({ url: publicUrl }) })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("gives project.get the name option in development", async () => {
    const { app, root } = await nuxtFixture()
    try {
      const { nitroConfig, nuxt } = createNuxt(app, true)
      await viteHubNuxt({ console: true, env: false, host: "node", name: "glosa", publicUrl }, nuxt)
      const config = await nitroConfig()
      const plugin = (config.plugins as string[]).find(file => file.includes("/.vitehub/nitro/console/"))
      if (!plugin) throw new TypeError("Expected the generated Console plugin.")
      expect(await readFile(plugin, "utf8")).toContain(`installConsoleProjectName(${JSON.stringify(app)}, "glosa")`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("lists static Schedules over signed RPC on the built Node server without a Process Runtime", { timeout: 240_000 }, async () => {
    const { app, root } = await nuxtFixture()
    try {
      const { nitroConfig, nuxt } = createNuxt(app, false)
      await mkdir(join(app, "server/schedules"), { recursive: true })
      await writeFile(join(app, "server/schedules/digest.ts"), `
import { defineSchedule } from "vite-hub/schedule"
export default defineSchedule({ cron: "0 9 * * *", timeZone: "Europe/Madrid", handler: () => {} })
`)
      await viteHubNuxt({ console: true, env: false, host: "node", publicUrl, schedule: { providerOutput: false } }, nuxt)
      const config = await nitroConfig()
      await buildNitro(config)

      for (const [key, value] of Object.entries(ci.env)) vi.stubEnv(key, value)
      const entry = pathToFileURL(join(app, ".output/server/index.mjs")).href
      const { default: server } = await import(entry) as { default: { fetch(request: Request): Promise<Response> } }
      const signed = await signedRpcRequest({ key: ci.key, operation: "schedule.list", url: `${publicUrl}/_vitehub/rpc` })
      const body = await signed.text()
      const localUrl = "http://127.0.0.1/_vitehub/rpc"
      const response = await server.fetch(new Request(localUrl, { body, headers: signed.headers, method: "POST" }))
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await operationRpcResponseResult(response)).toEqual({
        ok: true,
        value: { definitions: [{ cron: "0 9 * * *", name: "digest", timeZone: "Europe/Madrid" }], schedules: [] },
      })

      const unsigned = await server.fetch(new Request(localUrl, { body, headers: { "content-type": "application/json" }, method: "POST" }))
      expect(unsigned.status).toBe(401)
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })
})
