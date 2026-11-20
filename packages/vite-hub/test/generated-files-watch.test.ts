import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

import { createServer, resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

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
