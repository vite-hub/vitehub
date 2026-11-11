import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

// Generated server modules import the built package, so the test uses the same module graph.
import viteHubNuxt from "vite-hub/nuxt"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const ci = await consoleTestKey("CI")
const repositoryNodeModules = resolve(import.meta.dirname, "../../../node_modules")
const publicUrl = "http://app.example.com"

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === "string") throw new TypeError("Expected a TCP address.")
  return address.port
}

/**
 * A Nuxt 5 app root. The module finds Nitro 3 through the `nuxt` package that the app resolves, so the fixture puts a
 * small `nuxt` package above the app that depends on the installed Nitro 3.
 */
async function nuxtFixture(): Promise<{ app: string, root: string }> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-nuxt-signed-"))
  const nuxtPackage = join(root, "node_modules/nuxt")
  await mkdir(join(nuxtPackage, "node_modules"), { recursive: true })
  await writeFile(join(nuxtPackage, "package.json"), JSON.stringify({ name: "nuxt", version: "5.0.0", dependencies: { nitro: "3.0.0" } }))
  await symlink(join(repositoryNodeModules, "nitro"), join(nuxtPackage, "node_modules/nitro"), "dir")
  const app = join(root, "app")
  await mkdir(join(app, "server"), { recursive: true })
  await symlink(repositoryNodeModules, join(app, "node_modules"), "dir")
  await writeFile(join(app, "package.json"), JSON.stringify({ private: true, type: "module" }))
  return { app, root }
}

/** The parts of Nuxt that the module reads, with Nuxt building Nitro outside Vite. */
function createNuxt(app: string, dev: boolean) {
  const nitroConfigHooks: Array<(config: Record<string, unknown>) => Promise<void> | void> = []
  const modulesDoneHooks: Array<() => void> = []
  const nuxt = {
    callHook: async () => {},
    hook(name: string, callback: (...args: never[]) => unknown) {
      if (name === "nitro:config") nitroConfigHooks.push(callback as (config: Record<string, unknown>) => Promise<void>)
      if (name === "modules:done") modulesDoneHooks.push(callback as () => void)
    },
    options: {
      _installedModules: [],
      alias: {} as Record<string, string>,
      app: { baseURL: "/" },
      buildDir: join(app, ".nuxt"),
      dev,
      experimental: { nitroViteEnvironment: false },
      nitro: {} as Record<string, unknown>,
      plugins: [],
      rootDir: app,
      routeRules: {},
      router: { options: {} },
      serverDir: join(app, "server"),
      srcDir: app,
      vite: { plugins: [] },
    },
  }
  return {
    nuxt,
    async nitroConfig(): Promise<Record<string, unknown>> {
      for (const hook of modulesDoneHooks) hook()
      const config: Record<string, unknown> = {
        ...nuxt.options.nitro,
        // Nuxt gives Nitro its aliases, such as the generated `#vitehub/env/server`.
        alias: { ...nuxt.options.alias },
        buildDir: join(app, ".nuxt/nitro"),
        dev,
        output: { dir: join(app, ".output") },
        rootDir: app,
        serverDir: join(app, "server"),
      }
      for (const hook of nitroConfigHooks) await hook(config)
      return config
    },
  }
}

async function withServer<T>(app: string, run: (port: number) => Promise<T>): Promise<T> {
  const port = await freePort()
  const server = spawn(process.execPath, [join(app, ".output/server/index.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", NODE_ENV: "production", PORT: String(port), ...ci.env },
    stdio: "ignore",
  })
  try {
    return await run(port)
  }
  finally {
    server.kill()
  }
}

async function fetchWhenReady(url: string, init: RequestInit): Promise<Response> {
  const deadline = Date.now() + 20_000
  while (true) {
    try {
      return await fetch(url, init)
    }
    catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(done => setTimeout(done, 100))
    }
  }
}

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

  it("accepts a signed call on the built Node server", { timeout: 240_000 }, async () => {
    const { app, root } = await nuxtFixture()
    try {
      const { nitroConfig, nuxt } = createNuxt(app, false)
      await viteHubNuxt({ console: true, env: false, host: "node", publicUrl }, nuxt)
      const config = await nitroConfig()
      const { build, createNitro, prepare } = await import("nitro/builder")
      const nitro = await createNitro(config as Parameters<typeof createNitro>[0])
      try {
        await prepare(nitro)
        await build(nitro)
      }
      finally {
        await nitro.close()
      }

      await withServer(app, async (port) => {
        const signed = await signedRpcRequest({ key: ci.key, url: `${publicUrl}/_vitehub/rpc` })
        const body = await signed.text()
        // The Node adapter builds the request URL from this Host header. The signed origin must come from `publicUrl`.
        const response = await fetchWhenReady(`http://127.0.0.1:${port}/_vitehub/rpc`, { body, headers: signed.headers, method: "POST" })
        expect(response.status, await response.clone().text()).toBe(200)
        expect(await operationRpcResponseResult(response)).toMatchObject({ ok: true })

        const unsigned = await fetch(`http://127.0.0.1:${port}/_vitehub/rpc`, { body, headers: { "content-type": "application/json" }, method: "POST" })
        expect(unsigned.status).toBe(401)
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
