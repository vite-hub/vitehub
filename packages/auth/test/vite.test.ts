import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "vite"

import { AUTH_DEFINITION_ID, AUTH_SERVER_ID, hubAuth } from "../src/vite.ts"

const tempDirs: string[] = []
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url))

async function createTempProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-auth-vite-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function createWorkspaceTempProject(): Promise<string> {
  const rootDir = await mkdtemp(join(workspaceRoot, ".tmp-vitehub-auth-vite-"))
  tempDirs.push(rootDir)
  return rootDir
}

async function writeAuth(rootDir: string, path = "server/auth.ts", body: string[] = ["  appName: 'ViteHub',"]): Promise<string> {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineAuth } from '@vite-hub/auth'",
    "export default defineAuth({",
    ...body,
    "})",
    "",
  ].join("\n"))
  return file
}

async function resolvePluginConfig(plugin: ReturnType<typeof hubAuth>, root: string, plugins: Array<{ name: string }> = []): Promise<void> {
  await (plugin.configResolved as unknown as (config: { plugins: Array<{ name: string }>; root: string }) => Promise<void>)({ plugins, root })
}

function resolveAuthDefinition(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.resolveId as (id: string) => string | undefined)(AUTH_DEFINITION_ID)
}

function resolveAuthServer(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.resolveId as (id: string) => string | undefined)(AUTH_SERVER_ID)
}

function loadAuthDefinition(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.load as (id: string) => string | undefined)(`\0${AUTH_DEFINITION_ID}`)
}

function loadAuthServer(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.load as (id: string) => string | undefined)(`\0${AUTH_SERVER_ID}`)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubAuth", () => {
  it("serves a stable virtual Auth Definition module", async () => {
    const root = await createTempProject()
    const definition = await writeAuth(root)

    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)

    expect(resolveAuthDefinition(plugin)).toBe(`\0${AUTH_DEFINITION_ID}`)
    expect(loadAuthDefinition(plugin)).toContain(`import definition from ${JSON.stringify(definition)}`)
  })

  it("serves an empty virtual module when no Auth Definition exists", async () => {
    const root = await createTempProject()
    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)

    expect(loadAuthDefinition(plugin)).toBe("export const definition = undefined\nexport default definition\n")
  })

  it("serves a stable virtual Auth server helper module", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)

    expect(resolveAuthServer(plugin)).toBe(`\0${AUTH_SERVER_ID}`)
    expect(loadAuthServer(plugin)).toContain(`export * from "@vite-hub/auth/server"`)
    expect(loadAuthServer(plugin)).toContain(`export { handleAuth as default } from "@vite-hub/auth/server"`)
    await expect(readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")).resolves.toContain("declare module \"#vitehub/auth/server\"")
  })

  it("uses a configured package base in generated Auth runtime and type imports", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth(undefined, { importBase: "vite-hub/auth" })
    await resolvePluginConfig(plugin, root, [{ name: "@vite-hub/env/vite" }])

    expect(loadAuthServer(plugin)).toContain("from \"vite-hub/auth/server\"")
    expect(loadAuthServer(plugin)).not.toContain("@vite-hub/auth")
    const ambientTypes = await readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")
    expect(ambientTypes).toContain("namespace ViteHub")
    expect(ambientTypes).not.toContain("@vite-hub/auth")
    expect(ambientTypes).toContain("from \"vite-hub/auth/server\"")
    expect(ambientTypes).not.toContain("from \"@vite-hub/auth/server\"")
  })

  it("connects the virtual Auth server helper to ViteHub Env when available", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root, [{ name: "@vite-hub/env/vite" }])

    expect(loadAuthServer(plugin)).toContain("setAuthRuntimeEnvResolver")
    expect(loadAuthServer(plugin)).toContain("from \"#vitehub/env/server\"")
    const ambientTypes = await readFile(join(root, ".vitehub", "types", "auth.d.ts"), "utf8")
    expect(ambientTypes).toContain("import type { ServerEnv } from \"#vitehub/env/server\"")
    expect(ambientTypes).toContain("interface AuthRuntimeEnv extends ServerEnv")
  })

  it("lets top-level config disable the auth plugin", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth()
    await (plugin.configResolved as (config: { auth: false; root: string }) => Promise<void>)({ auth: false, root })

    expect(plugin.api.getConfig()).toBeUndefined()
    expect(loadAuthDefinition(plugin)).toBe("export const definition = undefined\nexport default definition\n")
  })

  it("marks the auth package as noExternal for Vite SSR module loading", () => {
    const plugin = hubAuth()
    const config = plugin.config as (config: { ssr?: { noExternal?: string[] } }) => unknown

    expect(config({})).toEqual({
      server: {
        watch: {
          ignored: ["**/.vitehub/**"],
        },
      },
      ssr: {
        noExternal: ["@vite-hub/auth"],
      },
    })
    expect(config({ ssr: { noExternal: ["existing"] } })).toEqual({
      server: {
        watch: {
          ignored: ["**/.vitehub/**"],
        },
      },
      ssr: {
        noExternal: ["existing", "@vite-hub/auth"],
      },
    })
  })

  it("registers the discovered Auth route with Nitro", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    const plugin = hubAuth()
    const config = plugin.config as (config: { root: string }) => unknown

    expect(config({ root })).toMatchObject({
      nitro: {
        handlers: [{
          handler: resolve(root, ".vitehub/auth/route.ts"),
          route: "/api/auth/**",
        }],
      },
    })
  })

  it("registers configured access routes as Nitro middleware", async () => {
    const root = await createTempProject()
    await writeAuth(root, "server/auth.ts", [
      "  appName: 'ViteHub',",
      "  access: {",
      "    routes: [",
      "      '/app',",
      "      '/app/**',",
      "      { method: 'POST', route: '/api/app' },",
      "    ],",
      "  },",
    ])
    const plugin = hubAuth()
    const config = plugin.config as (config: { root: string }) => unknown

    expect(config({ root })).toMatchObject({
      nitro: {
        handlers: [
          {
            handler: resolve(root, ".vitehub/auth/route.ts"),
            route: "/api/auth/**",
          },
          {
            handler: resolve(root, ".vitehub/auth/access-middleware.ts"),
            middleware: true,
            route: "/**",
          },
        ],
      },
    })
  })

  it("uses custom Auth base paths for generated Nitro routes", async () => {
    const root = await createTempProject()
    await writeAuth(root, "server/auth.ts", [
      "  appName: 'ViteHub',",
      "  basePath: '/auth',",
    ])
    const plugin = hubAuth()
    const config = plugin.config as (config: { root: string }) => unknown

    expect(config({ root })).toMatchObject({
      nitro: {
        handlers: [{
          handler: resolve(root, ".vitehub/auth/route.ts"),
          route: "/auth/**",
        }],
      },
    })
  })

  it("keeps route opt-out for hosts that mount Auth themselves", async () => {
    const root = await createTempProject()
    await writeAuth(root, "server/auth.ts", [
      "  appName: 'ViteHub',",
      "  route: false,",
    ])
    const plugin = hubAuth()
    const config = plugin.config as (config: { root: string }) => { nitro?: unknown }

    expect(config({ root }).nitro).toBeUndefined()
  })

  it("writes the generated Nitro Auth route handler", async () => {
    const root = await createTempProject()
    await writeAuth(root)
    const plugin = hubAuth()

    await resolvePluginConfig(plugin, root)

    await expect(readFile(join(root, ".vitehub", "auth", "route.ts"), "utf8")).resolves.toContain("export { default } from \"#vitehub/auth/server\"")
    await expect(readFile(join(root, ".vitehub", "auth", "access-middleware.ts"), "utf8")).resolves.toContain("import { requireAuth } from \"#vitehub/auth/server\"")
  })

  it("shares dev route sessions with the authenticated Agent helper in SSR modules", async () => {
    const root = await createWorkspaceTempProject()
    await writeAuth(root)
    await writeFile(join(root, "server", "auth.ts"), [
      "import { defineAuth } from '@vite-hub/auth'",
      "export default defineAuth({ appName: 'ViteHub', emailAndPassword: { enabled: true } })",
      "",
    ].join("\n"))
    await writeFile(join(root, "server", "check.ts"), [
      "import { authenticated } from '@vite-hub/auth/agent'",
      "export async function resolveInvoker(cookie = '', required = true) {",
      "  const store = new Map()",
      "  const options = authenticated({ required })",
      "  return await options.resolve({",
      "    context: { entries: () => store.entries(), get: id => store.get(id), has: id => store.has(id), set: (id, value) => store.set(id, value), toJSON: () => Object.fromEntries(store) },",
      "    defaultInvoker: { id: 'anonymous:test', kind: 'anonymous' },",
      "    input: {},",
      "    profiles: [],",
      "    request: new Request('http://localhost/api/agent', { headers: cookie ? { cookie } : {} }),",
      "    runtime: 'unknown',",
      "  })",
      "}",
      "",
    ].join("\n"))
    await writeFile(join(root, "index.html"), "<div>ok</div>")

    const server = await createServer({
      configFile: false,
      plugins: [hubAuth()],
      root,
      server: {
        host: "127.0.0.1",
        port: 0,
      },
    })

    try {
      await server.listen()
      const address = server.httpServer?.address()
      const port = typeof address === "object" && address ? address.port : undefined
      expect(port).toBeTypeOf("number")
      const module = await server.ssrLoadModule(join(root, "server", "check.ts")) as {
        resolveInvoker: (cookie?: string, required?: boolean) => Promise<{ id: string; kind?: string; meta?: Record<string, unknown> } | undefined>
      }
      const coldInvoker = await module.resolveInvoker("", false)

      const response = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email: `auth-${Date.now()}@example.com`,
          name: "Auth User",
          password: "passwordpassword",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      const invoker = await module.resolveInvoker(cookie)

      expect(coldInvoker).toBeUndefined()
      expect(response.status).toBe(200)
      if (!invoker) throw new Error("Expected authenticated invoker.")
      expect(invoker).toMatchObject({
        kind: "authUser",
        meta: {
          authUserId: invoker.id,
        },
      })
    }
    finally {
      await server.close()
    }
  })

  it("invalidates the virtual definition module during auth definition hot updates", async () => {
    const root = await createTempProject()
    const definition = await writeAuth(root)
    const invalidated: string[] = []
    const plugin = hubAuth()
    await resolvePluginConfig(plugin, root)

    const handleHotUpdate = plugin.handleHotUpdate as unknown as (context: {
      file: string
      server: {
        moduleGraph: {
          getModuleById: (id: string) => { id: string } | undefined
          invalidateModule: (module: { id: string }) => void
        }
      }
    }) => void

    handleHotUpdate({
      file: definition,
      server: {
        moduleGraph: {
          getModuleById(id) {
            if (id === `\0${AUTH_DEFINITION_ID}`) return { id }
          },
          invalidateModule(module) {
            invalidated.push(module.id)
          },
        },
      },
    })

    expect(invalidated).toEqual([`\0${AUTH_DEFINITION_ID}`])
  })
})
