import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { createBuilder, resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

// Generated server modules also import the package, so use one built module graph for request grants.
import { vitehub } from "vite-hub"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const ci = await consoleTestKey("CI")
const link = await consoleTestKey("CONSOLE_01234567")

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

async function withBuiltServer<T>(root: string, run: (fetchServer: (path: string, init?: RequestInit) => Promise<Response>, origin: string) => Promise<T>): Promise<T> {
  const port = await freePort()
  const server = spawn(process.execPath, [join(root, ".output/server/index.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", NODE_ENV: "production", PORT: String(port), ...ci.env, ...link.env },
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
    return await run(fetchServer, `http://127.0.0.1:${port}`)
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
      const plugin = join(root, "async-plugin.mjs")
      const guide = join(root, "guide.mjs")
      await writeFile(plugin, "export default async () => { await new Promise(resolve => setTimeout(resolve, 50)) }\n")
      await writeFile(guide, "export default () => new Response('<html><body>Guide</body></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })\n")
      const { nitro } = (await import("nitro/vite" as string)) as { nitro: (config: { framework?: { name: string, version: string }, plugins: string[], handlers: { route: string, handler: string }[] }) => unknown }
      const server = nitro({ plugins: [plugin], handlers: [{ route: "/guide", handler: guide }], ...nitroPosition === "before" ? { framework: { name: "nitro", version: "3.0.0-test-builder" } } : {} })
      const publicUrl = "https://app.example.com"
      const hub = vitehub({ host: "node", publicUrl, console: true })
      const builder = await createBuilder({
        logLevel: "silent",
        plugins: nitroPosition === "before" ? [server as never, hub] : [hub, server as never],
        root,
      })
      await builder.buildApp()

      await withBuiltServer(root, async (fetchServer) => {
        const page = await fetchServer("/_vitehub", { redirect: "manual" })
        expect(page.status).toBe(303)
        expect(page.headers.get("location")).toBe("/?vitehub")
        expect(page.headers.get("set-cookie")).toBeNull()
        const guideEntry = await fetchServer("/_vitehub/guide", { redirect: "manual" })
        expect(guideEntry.headers.get("location")).toBe("/guide?vitehub")
        const guidePage = await fetchServer("/guide?vitehub", { headers: { "x-forwarded-host": "app.example.com", "x-forwarded-proto": "https" } })
        expect(await guidePage.text()).toContain("data-vitehub-hosted-comments")
        const target = new URL((await fetchServer("/_vitehub/agents", { redirect: "manual" })).headers.get("location")!)
        expect(target.origin).toBe("https://console.vitehub.dev")
        expect(target.pathname).toBe("/open")
        expect(Object.fromEntries(target.searchParams)).toEqual({ path: "/agents", project: publicUrl })
        const signed = await signedRpcRequest({ key: ci.key, url: `${publicUrl}/_vitehub/rpc` })
        const rpc = await fetchServer("/_vitehub/rpc", { body: await signed.text(), headers: signed.headers, method: "POST" })
        expect(rpc.status, await rpc.clone().text()).toBe(200)
        expect(await operationRpcResponseResult(rpc)).toMatchObject({ ok: true })
        const { framework } = JSON.parse(await readFile(join(root, ".output/nitro.json"), "utf8"))
        expect(framework).toEqual({ name: "nitro", version: nitroPosition === "before" ? "3.0.0-test-builder" : expect.any(String) })
        const info = await signedRpcRequest({ key: ci.key, operation: "project.get", url: `${publicUrl}/_vitehub/rpc` })
        const response = await fetchServer("/_vitehub/rpc", { body: await info.text(), headers: info.headers, method: "POST" })
        expect(await operationRpcResponseResult(response)).toMatchObject({ ok: true, value: { build: { framework } } })
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
      await expect(resolveConfig({ configFile: false, plugins: [nitroInit, vitehub({ host: "node" })], root }, "build"))
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
      const config = await resolveConfig({ configFile: false, plugins: [nitroEnv, vitehub({ host: "node" })], root }, "build")
      expect(config.plugins.some(plugin => plugin.name === "vite-hub/nitro-order")).toBe(true)
    }
    finally {
      await rm(root, { force: true, recursive: true, maxRetries: 3 })
    }
  })
})
