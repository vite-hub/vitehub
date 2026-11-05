import { spawn } from "node:child_process"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder, resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

// Generated server modules also import the package, so use one built module graph for request grants.
import { vitehub } from "vite-hub"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

async function withBuiltServer<T>(root: string, run: (fetchServer: (path: string, init?: RequestInit) => Promise<Response>) => Promise<T>): Promise<T> {
  const port = await freePort()
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", NODE_ENV: "production", PORT: String(port) },
    stdio: "ignore",
  })
  const fetchServer = async (path: string, init?: RequestInit): Promise<Response> => {
    const deadline = Date.now() + 20_000
    while (true) {
      try {
        return await fetch(`http://127.0.0.1:${port}${path}`, init)
      }
      catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise(done => setTimeout(done, 100))
      }
    }
  }
  try {
    return await run(fetchServer)
  }
  finally {
    server.kill()
  }
}

describe("Plugin order with the Nitro Vite plugin", () => {
  it.each(["before", "after"] as const)("keeps the Console routes when nitro() comes %s vitehub()", async (nitroPosition) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-plugin-order-"))
    try {
      await symlink(resolve(import.meta.dirname, "../../../node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))
      await writeFile(join(root, "index.html"), "<main>ok</main>\n")
      const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
      const hub = vitehub({ preset: "node", console: { auth: false, authorize: hostManagedAuthorize } })
      const builder = await createBuilder({
        logLevel: "silent",
        plugins: nitroPosition === "before" ? [nitro() as never, hub] : [hub, nitro() as never],
        root,
      })
      await builder.buildApp()

      await withBuiltServer(root, async (fetchServer) => {
        const page = await fetchServer("/_vitehub")
        expect(page.status).toBe(200)
        expect(await page.text()).toContain("<html")
        const rpc = await fetchServer("/_vitehub/rpc/__call", {
          body: JSON.stringify({ operation: "sections.list", input: {} }),
          headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
          method: "POST",
        })
        expect(rpc.status, await rpc.clone().text()).toBe(200)
        expect(await rpc.json()).toMatchObject({ ok: true })
      })
    }
    finally {
      await rm(root, { force: true, recursive: true, maxRetries: 3 })
    }
  }, 180_000)

  it.each([
    ["a config hook object without a handler", { order: "post" }],
    ["a config hook that runs first", { order: "pre", handler: () => undefined }],
  ])("fails with a coded error when Nitro has %s", async (_name, config) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-plugin-order-"))
    try {
      // A Nitro version with such a hook leaves ViteHub no way to run it later exactly once.
      const nitroInit = { name: "nitro:init", config } as never
      await expect(resolveConfig({ configFile: false, plugins: [nitroInit, vitehub({ preset: "node" })], root }, "build"))
        .rejects.toMatchObject({ code: "VITE_HUB_R0135", message: expect.stringContaining("Put vitehub() before nitro()") })
    }
    finally {
      await rm(root, { force: true, recursive: true, maxRetries: 3 })
    }
  })

  it("leaves a Nitro plugin without a config hook alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-plugin-order-"))
    try {
      const nitroEnv = { name: "nitro:env" } as never
      const config = await resolveConfig({ configFile: false, plugins: [nitroEnv, vitehub({ preset: "node" })], root }, "build")
      expect(config.plugins.some(plugin => plugin.name === "vite-hub/nitro-order")).toBe(true)
    }
    finally {
      await rm(root, { force: true, recursive: true, maxRetries: 3 })
    }
  })
})
