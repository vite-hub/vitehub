import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { env } from "@vite-hub/env"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "vite"

import { createEmail } from "../src/client.ts"
import { EMAIL_DEFINITION_ID, hubEmail } from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-vite-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  return root
}

async function writeEmail(root: string, path = "server/email.ts"): Promise<string> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, [
    "import { defineEmail } from '@vite-hub/email'",
    "export default defineEmail({ driver: { name: 'fixture', send: async () => ({ id: 'fixture-1' }) } })",
    "",
  ].join("\n"))
  return file
}

async function resolvePlugin(plugin: ReturnType<typeof hubEmail>, root: string): Promise<void> {
  await (plugin.configResolved as (config: { root: string }) => void)({ root })
}

function resolveDefinition(plugin: ReturnType<typeof hubEmail>): string | undefined {
  return (plugin.resolveId as (id: string) => string | undefined)(EMAIL_DEFINITION_ID)
}

function loadDefinition(plugin: ReturnType<typeof hubEmail>): string | undefined {
  return (plugin.load as (id: string) => string | undefined)(`\0${EMAIL_DEFINITION_ID}`)
}

async function loadConfiguredDefinition(plugin: ReturnType<typeof hubEmail>): Promise<string> {
  const definition = plugin.api.getDefinition()
  if (definition?.source !== "vite-config") throw new Error("Expected a configured Email definition")
  return await readFile(definition.handler, "utf8")
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubEmail", () => {
  it("serves the discovered Email Definition through a stable virtual module", async () => {
    const root = await createTempProject()
    const definition = await writeEmail(root)
    const plugin = hubEmail()

    await resolvePlugin(plugin, root)

    expect(resolveDefinition(plugin)).toBe(`\0${EMAIL_DEFINITION_ID}`)
    expect(loadDefinition(plugin)).toContain(`import definition from ${JSON.stringify(definition)}`)
  })

  it("serves an empty module when no Email Definition exists", async () => {
    const root = await createTempProject()
    const plugin = hubEmail()

    await resolvePlugin(plugin, root)

    expect(loadDefinition(plugin)).toBe("export const definition = undefined\nexport default definition\n")
  })

  it("generates a server-only Unemail definition without resolving credentials at config time", async () => {
    const root = await createTempProject()
    const secret = "re_build-secret-sentinel"
    vi.stubEnv("RESEND_API_KEY", secret)
    const plugin = hubEmail({
      driver: "unemail/driver/resend",
      options: {
        apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }),
      },
    })

    await resolvePlugin(plugin, root)

    const definition = plugin.api.getDefinition()
    expect(definition).toMatchObject({
      driver: "unemail/driver/resend",
      name: "default",
      source: "vite-config",
    })
    expect(loadDefinition(plugin)).toContain(JSON.stringify(definition?.handler))
    const source = await loadConfiguredDefinition(plugin)
    expect(source).toContain("https://api.resend.com")
    expect(source).toContain("RESEND_API_KEY")
    expect(source).toContain("options[\"apiKey\"]?.unseal()")
    expect(source).not.toContain(secret)
  })

  it("reads Cloudflare Email credentials from the current runtime binding", async () => {
    const root = await createTempProject()
    const plugin = hubEmail({
      driver: "unemail/driver/resend",
      options: {
        apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }),
      },
    })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Record<string, unknown>

    expect(config({ nitro: { preset: "cloudflare-module" } })).toMatchObject({
      nitro: { rollupConfig: { external: ["cloudflare:workers"] } },
    })
    await resolvePlugin(plugin, root)

    const source = await loadConfiguredDefinition(plugin)
    expect(source).toMatch(/import\s*\{\s*env as vitehubEmailEnv\s*\}\s*from\s*"cloudflare:workers"/)
    expect(source).toContain("resolveServerEnv(registry,{env:vitehubEmailEnv})")
  })

  it("uses the development Nitro preset instead of the deployment target", async () => {
    const root = await createTempProject()
    const plugin = hubEmail({
      driver: "unemail/driver/resend",
      hosting: "cloudflare-module",
    } as Parameters<typeof hubEmail>[0])
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Record<string, unknown>

    expect(config({ nitro: { preset: "node-server" } })).not.toHaveProperty("nitro")
    await resolvePlugin(plugin, root)

    expect(await loadConfiguredDefinition(plugin)).not.toContain("cloudflare:workers")
  })

  it("resolves a fresh Cloudflare credential for every send", async () => {
    const root = await createTempProject()
    const cloudflareWorkers = join(root, "cloudflare-workers.ts")
    await writeFile(cloudflareWorkers, [
      "export const env: Record<string, unknown> = {}",
      "",
    ].join("\n"))
    const server = await createServer({
      appType: "custom",
      configFile: false,
      nitro: { preset: "cloudflare-module" },
      plugins: [hubEmail({
        driver: "unemail/driver/resend",
        options: {
          apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }),
        },
      })],
      resolve: { alias: { "cloudflare:workers": cloudflareWorkers } },
      root,
      server: { middlewareMode: true },
    } as never)
    const authorizations: string[] = []
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      return Response.json({ id: `message-${authorizations.length}` })
    })

    try {
      const module = await server.ssrLoadModule(EMAIL_DEFINITION_ID) as { default: Parameters<typeof createEmail>[0] }
      const cloudflare = await server.ssrLoadModule(cloudflareWorkers) as { env: Record<string, unknown> }
      const client = createEmail(module.default)
      for (const apiKey of ["re_first", "re_second"]) {
        cloudflare.env.RESEND_API_KEY = apiKey
        await client.send({ from: "from@example.com", subject: "Runtime secret", text: "Hello", to: "to@example.com" })
      }
      expect(authorizations).toEqual(["Bearer re_first", "Bearer re_second"])
    }
    finally {
      await server.close()
      vi.unstubAllGlobals()
    }
  })

  it("rejects configured and discovered definitions together", async () => {
    const root = await createTempProject()
    await writeEmail(root)

    await expect(resolvePlugin(hubEmail({ driver: "unemail/driver/resend" }), root)).rejects.toThrow("Remove one definition")
  })

  it("rejects driver names outside Unemail driver subpaths", () => {
    expect(() => hubEmail({ driver: "resend" as "unemail/driver/resend" })).toThrow("unemail/driver/*")
  })

  it("rejects secret defaults that would be included in build output", () => {
    expect(() => hubEmail({
      driver: "unemail/driver/resend",
      options: {
        apiKey: env({ default: "re_build-secret", secret: true, source: env.source("RESEND_API_KEY") }),
      },
    })).toThrow("email.options.apiKey cannot have a default")
  })

  it("rejects ambiguous singleton definitions", async () => {
    const root = await createTempProject()
    await writeEmail(root)
    await writeEmail(root, "server.email.ts")

    await expect(resolvePlugin(hubEmail(), root)).rejects.toThrow("Only one Email Definition is allowed")
  })

  it("resolves definitions from an explicit project root", async () => {
    const root = await createTempProject()
    const appRoot = join(root, "app")
    await mkdir(appRoot)
    const definition = await writeEmail(root)
    const plugin = hubEmail({ projectRoot: ".." })

    await resolvePlugin(plugin, appRoot)

    expect(loadDefinition(plugin)).toContain(JSON.stringify(definition))
  })

  it("discovers an email-only project above an app Vite root", async () => {
    const root = await createTempProject()
    const appRoot = join(root, "app")
    await mkdir(appRoot)
    const definition = await writeEmail(root)
    const plugin = hubEmail()

    await resolvePlugin(plugin, appRoot)

    expect(loadDefinition(plugin)).toContain(JSON.stringify(definition))
  })

  it("marks the package as noExternal for server environments", () => {
    const plugin = hubEmail()
    const config = plugin.config as (config: { ssr?: { noExternal?: string[] } }) => unknown
    const configEnvironment = plugin.configEnvironment as (name: string, config: { consumer?: string; resolve?: { noExternal?: string[] } }) => unknown

    expect(config({})).toEqual({ ssr: { noExternal: ["@vite-hub/email"] } })
    expect(config({ ssr: { noExternal: ["existing"] } })).toEqual({
      ssr: { noExternal: ["existing", "@vite-hub/email"] },
    })
    expect(configEnvironment("client", {})).toBeUndefined()
    expect(configEnvironment("ssr", {})).toEqual({
      resolve: { noExternal: ["@vite-hub/email"] },
    })
  })

  it("refreshes and invalidates the virtual definition on definition changes", async () => {
    const root = await createTempProject()
    const plugin = hubEmail()
    await resolvePlugin(plugin, root)
    const definition = await writeEmail(root)
    const virtualModule = {}
    const invalidateModule = vi.fn()

    await (plugin.handleHotUpdate as (context: unknown) => void)({
      file: definition,
      server: {
        config: { root },
        moduleGraph: {
          getModuleById: vi.fn(() => virtualModule),
          invalidateModule,
        },
      },
    })

    expect(loadDefinition(plugin)).toContain(JSON.stringify(definition))
    expect(invalidateModule).toHaveBeenCalledWith(virtualModule)
  })
})
