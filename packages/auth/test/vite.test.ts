import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "vite"

import { AUTH_DEFINITION_ID, hubAuth } from "../src/vite.ts"

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

async function writeAuth(rootDir: string, path = "server/auth.ts"): Promise<string> {
  const file = join(rootDir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineAuth } from '@vite-hub/auth'",
    "export default defineAuth({ appName: 'ViteHub' })",
    "",
  ].join("\n"))
  return file
}

function resolvePluginConfig(plugin: ReturnType<typeof hubAuth>, root: string): void {
  ;(plugin.configResolved as (config: { root: string }) => void)({ root })
}

function resolveAuthDefinition(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.resolveId as (id: string) => string | undefined)(AUTH_DEFINITION_ID)
}

function loadAuthDefinition(plugin: ReturnType<typeof hubAuth>): string | undefined {
  return (plugin.load as (id: string) => string | undefined)(`\0${AUTH_DEFINITION_ID}`)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubAuth", () => {
  it("serves a stable virtual Auth Definition module", async () => {
    const root = await createTempProject()
    const definition = await writeAuth(root)

    const plugin = hubAuth()
    resolvePluginConfig(plugin, root)

    expect(resolveAuthDefinition(plugin)).toBe(`\0${AUTH_DEFINITION_ID}`)
    expect(loadAuthDefinition(plugin)).toContain(`import definition from ${JSON.stringify(definition)}`)
  })

  it("serves an empty virtual module when no Auth Definition exists", async () => {
    const root = await createTempProject()
    const plugin = hubAuth()
    resolvePluginConfig(plugin, root)

    expect(loadAuthDefinition(plugin)).toBe("export const definition = undefined\nexport default definition\n")
  })

  it("lets top-level config disable the auth plugin", async () => {
    const root = await createTempProject()
    await writeAuth(root)

    const plugin = hubAuth()
    ;(plugin.configResolved as (config: { auth: false; root: string }) => void)({ auth: false, root })

    expect(plugin.api.getConfig()).toBeUndefined()
    expect(loadAuthDefinition(plugin)).toBe("export const definition = undefined\nexport default definition\n")
  })

  it("marks the auth package as noExternal for Vite SSR module loading", () => {
    const plugin = hubAuth()
    const config = plugin.config as (config: { ssr?: { noExternal?: string[] } }) => unknown

    expect(config({})).toEqual({
      ssr: {
        noExternal: ["@vite-hub/auth"],
      },
    })
    expect(config({ ssr: { noExternal: ["existing"] } })).toEqual({
      ssr: {
        noExternal: ["existing", "@vite-hub/auth"],
      },
    })
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
    resolvePluginConfig(plugin, root)

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
