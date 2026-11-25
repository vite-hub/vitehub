import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it, vi } from "vitest"

// Generated server modules import the built package, so the test uses the same module graph.
import viteHubNuxt from "vite-hub/nuxt"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const ci = await consoleTestKey("CI")
const repositoryNodeModules = resolve(import.meta.dirname, "../../../node_modules")
const publicUrl = "http://app.example.com"

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
      nitro: {} as Record<string, unknown> & { alias?: Record<string, string> },
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
        // Nuxt gives Nitro its aliases, such as the generated `#vitehub/env/server`, merged with `nitro.alias`.
        alias: { ...nuxt.options.alias, ...nuxt.options.nitro.alias },
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
      const appModule = (config.alias as Record<string, string>)["#vitehub/console/app"]
      if (!appModule) throw new TypeError("Expected the generated Console app module.")
      expect(await readFile(appModule, "utf8")).toContain(`installConsoleProjectName(${JSON.stringify(app)}, "glosa")`)
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
      const { build, createNitro, prepare } = await import("nitro/builder")
      const nitro = await createNitro({ ...config, preset: "standard" })
      try {
        await prepare(nitro)
        await build(nitro)
      }
      finally {
        await nitro.close()
      }

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
