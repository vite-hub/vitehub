import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

import { findViteHubNitroDevEnvironment } from "@vite-hub/internal/dev-endpoint"
import { createServer, resolveConfig } from "vite"
import { describe, expect, it, vi } from "vitest"

import { vitehub } from "vite-hub"
import { env } from "vite-hub/env"

describe("generated files and the dev watcher", () => {
  it("keeps .vitehub/ out of the watcher of an app without Workspace, Agent, or Auth", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".generated-files-watch-"))
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    try {
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
      await mkdir(join(root, "server"), { recursive: true })
      server = await createServer({
        configFile: false,
        logLevel: "silent",
        root,
        plugins: [vitehub({ host: "node", env: { server: { model: env({ default: "model", source: env.source("AI_MODEL") }) } } })],
        server: { host: "127.0.0.1", port: 0, hmr: false },
      })
      await server.listen()
      const events: string[] = []
      server.watcher.on("all", (event, file) => events.push(`${event} ${relative(root, file)}`))
      await mkdir(join(root, ".vitehub/types"), { recursive: true })
      await writeFile(join(root, ".vitehub/types/generated.d.ts"), "export {}\n")
      await writeFile(join(root, "server/app.ts"), "export {}\n")
      const deadline = Date.now() + 30_000
      while (!events.includes("add server/app.ts") && Date.now() < deadline) await new Promise(done => setTimeout(done, 100))
      expect(events).toContain("add server/app.ts")
      expect(events.filter(event => event.includes(".vitehub"))).toEqual([])
    }
    finally {
      await server?.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("updates the Nitro Connections registry when colocated docs are added or removed", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".generated-files-connections-"))
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    vi.stubEnv("VITEST", undefined)
    vi.stubEnv("NITRO_DEV_RUNNER", "self")
    try {
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
      await mkdir(join(root, "server/connections"), { recursive: true })
      await mkdir(join(root, "server/routes"), { recursive: true })
      await writeFile(join(root, "server/connections/crm.ts"), `
import { apiKey, defineConnection } from "vite-hub/connections"
export default defineConnection({ provider: apiKey({ fallback: () => "test-key", origins: ["https://example.com"] }) })
`)
      await writeFile(join(root, "server/routes/connection.get.ts"), `
import { getConnectionsRuntime } from "vite-hub/connections/server"
export default () => getConnectionsRuntime().inspect("crm")
`)
      server = await createServer({
        configFile: false,
        logLevel: "silent",
        root,
        plugins: [vitehub({ host: "node", connections: true })],
        server: { middlewareMode: true, ws: false },
      })
      const environment = findViteHubNitroDevEnvironment(server)
      expect(environment).toBeDefined()
      const inspect = async () => {
        const response = await environment!.dispatchFetch(new Request("http://localhost/connection"))
        const body = await response.text()
        expect(response.status, body).toBe(200)
        return JSON.parse(body)
      }
      const initial = await inspect()
      expect(initial).toMatchObject({ name: "crm" })
      expect(initial).not.toHaveProperty("docs")

      const docsFile = join(root, "server/connections/crm.md")
      await writeFile(docsFile, "# CRM setup\n")
      server.watcher.emit("add", docsFile)
      const registryFile = join(root, ".vitehub/nitro/connections/registry.ts")
      await vi.waitFor(async () => expect(await readFile(registryFile, "utf8")).toContain("crm.md?raw"))
      await vi.waitFor(async () => expect(await inspect()).toHaveProperty("docs", "# CRM setup\n"), { timeout: 15_000, interval: 100 })

      await rm(docsFile)
      server.watcher.emit("unlink", docsFile)
      await vi.waitFor(async () => expect(await inspect()).not.toHaveProperty("docs"), { timeout: 15_000, interval: 100 })
    }
    finally {
      await server?.close()
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("adds the pattern once, after the app's own patterns", async () => {
    const config = await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: [vitehub({ host: "node", env: false })],
      server: { watch: { ignored: ["**/dist/**"] } },
    }, "serve")
    expect(config.server.watch?.ignored).toEqual(["**/dist/**", "**/.vitehub/**"])
  })

  it("leaves a watcher that the app turned off", async () => {
    const config = await resolveConfig({ configFile: false, logLevel: "silent", plugins: [vitehub({ host: "node", env: false })], server: { watch: null } }, "serve")
    expect(config.server.watch).toBeNull()
  })
})
