import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { env } from "@vite-hub/env"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "vite"

import { createEmail } from "../src/client.ts"
import { EMAIL_DEFINITION_ID, hubEmail, hubEmailOptionalPeerResolver, resolveEmailTemplateModulePath } from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-email-vite-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  return root
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
  if (!definition) throw new Error("Expected a configured Email definition")
  return await readFile(definition.handler, "utf8")
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubEmail", () => {
  it("removes stale Email declarations when the integration is disabled", async () => {
    const root = await createTempProject()
    const declaration = join(root, ".vitehub", "types", "email.d.ts")
    await mkdir(join(root, ".vitehub", "types"), { recursive: true })
    await writeFile(declaration, "stale declarations\n")

    await hubEmailOptionalPeerResolver().api.prepareTypes(root)

    await expect(readFile(declaration, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves declarations owned by a separately installed Email plugin", async () => {
    const root = await createTempProject()
    const declaration = join(root, ".vitehub", "types", "email.d.ts")
    await mkdir(join(root, ".vitehub", "types"), { recursive: true })
    await writeFile(declaration, "owned declarations\n")
    const resolver = hubEmailOptionalPeerResolver()

    await (resolver.configResolved as unknown as (config: { plugins: { name: string }[], root: string }) => Promise<void>)({
      plugins: [{ name: "@vite-hub/email/vite" }, resolver],
      root,
    })

    await expect(readFile(declaration, "utf8")).resolves.toBe("owned declarations\n")
  })

  it("owns generated template module paths", () => {
    expect(resolveEmailTemplateModulePath("/tmp/templates", "#vitehub/emails/monthly/detail"))
      .toBe("/tmp/templates/monthly%2Fdetail.mjs")
    expect(resolveEmailTemplateModulePath("/tmp/templates", "other/module")).toBeUndefined()
    expect(() => resolveEmailTemplateModulePath("/tmp/templates", "#vitehub/emails/../secret"))
      .toThrow("Invalid Email template")
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
    })
    expect(resolveDefinition(plugin)).toBe(`\0${EMAIL_DEFINITION_ID}`)
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
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Promise<Record<string, unknown>>

    const cloudflareConfig = { nitro: {
      cloudflare: { wrangler: { compatibility_flags: ["custom"] } },
      preset: "cloudflare-module",
    } }
    expect(await config(cloudflareConfig)).not.toHaveProperty("nitro")
    expect(cloudflareConfig).toMatchObject({
      nitro: {
        cloudflare: { nodeCompat: true, wrangler: { compatibility_flags: ["custom"] } },
        rollupConfig: { external: ["cloudflare:workers"] },
      },
    })
    await resolvePlugin(plugin, root)

    const source = await loadConfiguredDefinition(plugin)
    expect(source).toMatch(/import\s*\{\s*env as vitehubEmailEnv\s*\}\s*from\s*"cloudflare:workers"/)
    expect(source).toContain("resolveServerEnv(registry,{env:vitehubEmailEnv})")
  })

  it("wires the Cloudflare Email driver to its Worker binding", async () => {
    const root = await createTempProject()
    const plugin = hubEmail({ driver: "unemail/driver/cloudflare-email" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Promise<Record<string, unknown>>
    const cloudflareConfig = { nitro: { preset: "cloudflare-module" } }

    await config(cloudflareConfig)
    expect(cloudflareConfig).toMatchObject({
      nitro: {
        cloudflare: { wrangler: { send_email: [{ name: "EMAIL" }] } },
        rollupConfig: { external: ["cloudflare:workers", "cloudflare:email"] },
      },
    })

    await resolvePlugin(plugin, root)
    const source = await loadConfiguredDefinition(plugin)
    expect(source).toContain("cloudflare:email")
    expect(source).toContain("binding:vitehubEmailEnv.EMAIL")
    expect(source).toContain("EmailMessage")
    expect(source).not.toContain("fileURLToPath(import.meta.url)")
  })

  it("generates exact virtual module types for discovered Email templates", async () => {
    const root = await createTempProject()
    const template = join(root, "server", "emails", "monthly-recap.md")
    const nestedTemplate = join(root, "server", "emails", "monthly-recap", "index.mjs", "detail.md")
    await mkdir(join(root, "server", "emails", "monthly-recap", "index.mjs"), { recursive: true })
    await writeFile(template, "Hello {{name}}")
    await writeFile(nestedTemplate, "Nested detail")
    const plugin = hubEmail({ driver: "unemail/driver/cloudflare-email" })

    await resolvePlugin(plugin, root)

    expect(await (plugin.resolveId as (id: string) => Promise<string>)("#vitehub/emails/monthly-recap"))
      .toBe(`/@fs/${template}?markdown-template`)
    expect(await readFile(join(root, ".vitehub", "types", "email.d.ts"), "utf8")).toBe([
      'declare module "#vitehub/emails/monthly-recap/index.mjs/detail" {',
      "  const render: (data?: Record<string, unknown>) => Promise<string>",
      "  export default render",
      "}",
      "",
      'declare module "#vitehub/emails/monthly-recap" {',
      "  const render: (data?: Record<string, unknown>) => Promise<string>",
      "  export default render",
      "}",
      "",
    ].join("\n"))
    await expect(readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" })
    await expect(plugin.api.prepareTypes({ materialize: true, projectRoot: root }))
      .resolves.toEqual({
        "monthly-recap": join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"),
        "monthly-recap/index.mjs/detail": join(root, ".vitehub", "email", "templates", "monthly-recap%2Findex.mjs%2Fdetail.mjs"),
      })
    expect(await readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .toContain("Hello {{name}}")
    expect(await readFile(join(root, ".vitehub", "email", "templates", "monthly-recap%2Findex.mjs%2Fdetail.mjs"), "utf8"))
      .toContain("Nested detail")
    await rm(template)
    await rm(nestedTemplate)
    await plugin.api.prepareTypes({ materialize: true, projectRoot: root })
    await expect(readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(root, ".vitehub", "types", "email.d.ts"), "utf8")).toBe("")
    expect(() => (plugin.resolveId as (id: string) => string)("#vitehub/emails/../secret"))
      .toThrow("Invalid Email template")
  })

  it("materializes templates before Cloudflare builds", async () => {
    const root = await createTempProject()
    await mkdir(join(root, "server", "emails"), { recursive: true })
    await writeFile(join(root, "server", "emails", "monthly-recap.md"), "Hello {{name}}")
    const plugin = hubEmail({
      driver: "unemail/driver/cloudflare-email",
      hosting: "cloudflare-module",
    } as Parameters<typeof hubEmail>[0])
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Promise<Record<string, unknown>>

    expect(await config({ root })).toMatchObject({ resolve: { alias: [
      { find: EMAIL_DEFINITION_ID, replacement: join(root, ".vitehub", "email", "definition.mjs") },
      {
        find: /^#vitehub\/emails\/monthly-recap$/,
        replacement: join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"),
      },
    ] } })
    await resolvePlugin(plugin, root)

    expect(await readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .toContain("Hello {{name}}")
    const buildStart = plugin.buildStart as unknown as (this: { addWatchFile: (file: string) => void }) => Promise<void>
    const addWatchFile = vi.fn()
    await buildStart.call({ addWatchFile })
    expect(addWatchFile).toHaveBeenCalledWith(join(root, "server", "emails"))
    await writeFile(join(root, "server", "emails", "monthly-recap.md"), "Updated template")
    await buildStart.call({ addWatchFile: vi.fn() })
    expect(await readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .toContain("Updated template")
  })

  it("exposes its generated definition to explicitly selected Vercel Workflows", async () => {
    const root = await createTempProject()
    const plugin = hubEmail({
      driver: "unemail/driver/resend",
      workflowProvider: "vercel",
    } as Parameters<typeof hubEmail>[0])
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Promise<Record<string, unknown>>

    expect(await config({ root })).toMatchObject({ resolve: { alias: [
      { find: EMAIL_DEFINITION_ID, replacement: join(root, ".vitehub", "email", "definition.mjs") },
    ] } })
  })

  it("resolves nested standalone host templates through exact aliases", async () => {
    const root = await createTempProject()
    const parentTemplate = join(root, "server", "emails", "monthly.md")
    const nestedTemplate = join(root, "server", "emails", "monthly", "detail.md")
    await mkdir(join(root, "server", "emails"), { recursive: true })
    await writeFile(parentTemplate, "Monthly")
    const server = await createServer({
      appType: "custom",
      configFile: false,
      plugins: [hubEmail({ driver: "unemail/driver/resend", hosting: "vercel" } as Parameters<typeof hubEmail>[0])],
      root,
      server: { middlewareMode: true },
    })
    try {
      await mkdir(join(root, "server", "emails", "monthly"))
      await writeFile(nestedTemplate, "Nested detail")
      expect((await server.pluginContainer.resolveId("#vitehub/emails/monthly/detail"))?.id)
        .toBe(`/@fs${nestedTemplate}?markdown-template`)
    }
    finally {
      await server.close()
    }
  })

  it("discovers every configured Email server directory", async () => {
    const root = await createTempProject()
    const firstServerDir = join(root, "layers", "first", "server")
    const secondServerDir = join(root, "layers", "second", "server")
    await mkdir(join(firstServerDir, "emails"), { recursive: true })
    await mkdir(join(secondServerDir, "emails", "first"), { recursive: true })
    await writeFile(join(firstServerDir, "emails", "first.md"), "First")
    await writeFile(join(secondServerDir, "emails", "first", "second.md"), "Second")
    const plugin = hubEmail({ driver: "unemail/driver/resend" })
    await expect(plugin.api.prepareTypes({ materialize: true, projectRoot: root, serverDirs: [firstServerDir, secondServerDir] })).resolves.toEqual({
      "first/second": join(root, ".vitehub", "email", "templates", "first%2Fsecond.mjs"),
      first: join(root, ".vitehub", "email", "templates", "first.mjs"),
    })
  })

  it("discovers an Email-only project root above an app Vite root", async () => {
    const root = await createTempProject()
    const appRoot = join(root, "app")
    await mkdir(join(root, "server", "emails"), { recursive: true })
    await mkdir(appRoot)
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ private: true }))
    await writeFile(join(root, "server", "emails", "welcome.md"), "Welcome")
    const plugin = hubEmail({ driver: "unemail/driver/resend", hosting: "vercel" } as Parameters<typeof hubEmail>[0])
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Promise<Record<string, unknown>>
    await expect(config({ root: appRoot })).resolves.toMatchObject({ resolve: { alias: [
      { find: EMAIL_DEFINITION_ID, replacement: join(appRoot, ".vitehub", "email", "definition.mjs") },
      {
        find: /^#vitehub\/emails\/welcome$/,
        replacement: join(root, ".vitehub", "email", "templates", "welcome.mjs"),
      },
    ] } })
  })

  it("serializes development refreshes and watches imported templates", async () => {
    const root = await createTempProject()
    const templatesRoot = join(root, "server", "emails")
    const sharedTemplate = join(root, "server", "shared", "footer.md")
    await mkdir(templatesRoot, { recursive: true })
    await mkdir(join(root, "server", "shared"), { recursive: true })
    await writeFile(join(templatesRoot, "monthly-recap.md"), "Hello\n@../shared/footer.md")
    await writeFile(sharedTemplate, "First footer")
    const plugin = hubEmail({
      driver: "unemail/driver/resend",
      hosting: "vercel",
    } as Parameters<typeof hubEmail>[0])
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Promise<Record<string, unknown>>
    await config({ root })
    await resolvePlugin(plugin, root)

    const handlers = new Map<string, (file: string) => void>()
    const send = vi.fn()
    const logError = vi.fn()
    const addWatchPaths = vi.fn()
    const generatedModule = { id: join(root, ".vitehub", "email", "templates", "monthly-recap.mjs") }
    const invalidateModule = vi.fn()
    ;(plugin.configureServer as unknown as (server: Record<string, unknown>) => void)({
      config: { logger: { error: logError } },
      moduleGraph: {
        idToModuleMap: new Map([[generatedModule.id, generatedModule]]),
        invalidateModule,
      },
      watcher: {
        add: addWatchPaths,
        on: (event: string, handler: (file: string) => void) => handlers.set(event, handler),
      },
      ws: { send },
    })

    await writeFile(sharedTemplate, "Updated footer")
    handlers.get("change")?.(sharedTemplate)
    handlers.get("change")?.(sharedTemplate)

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(invalidateModule).toHaveBeenCalledWith(generatedModule)
    expect(await readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .toContain("Updated footer")

    await writeFile(join(templatesRoot, "monthly-recap.md"), "@../shared/missing.md")
    handlers.get("change")?.(join(templatesRoot, "monthly-recap.md"))
    handlers.get("change")?.(join(templatesRoot, "monthly-recap.md"))

    await vi.waitFor(() => expect(logError).toHaveBeenCalledTimes(2))
    const missingTemplate = join(root, "server", "shared", "missing.md")
    expect(addWatchPaths).toHaveBeenCalledWith(expect.arrayContaining([missingTemplate]))
    expect(send).toHaveBeenCalledOnce()
    expect(await readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .toContain("Updated footer")

    await writeFile(missingTemplate, "Recovered footer")
    handlers.get("add")?.(missingTemplate)

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(await readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .toContain("Recovered footer")
  })

  it("uses the development Nitro preset instead of the deployment target", async () => {
    const root = await createTempProject()
    const template = join(root, "server", "emails", "monthly-recap.md")
    await mkdir(join(root, "server", "emails"), { recursive: true })
    await writeFile(template, "Initial template")
    const plugin = hubEmail({
      driver: "unemail/driver/resend",
      hosting: "cloudflare-module",
    } as Parameters<typeof hubEmail>[0])
    const config = plugin.config as unknown as (config: Record<string, unknown>) => Promise<Record<string, unknown>>

    expect(await config({ nitro: { preset: "node-server" } })).not.toHaveProperty("nitro")
    await plugin.api.prepareTypes({ materialize: true, projectRoot: root })
    await resolvePlugin(plugin, root)

    expect(await loadConfiguredDefinition(plugin)).not.toContain("cloudflare:workers")

    const handlers = new Map<string, (file: string) => void>()
    const send = vi.fn()
    ;(plugin.configureServer as unknown as (server: Record<string, unknown>) => void)({
      config: { logger: { error: vi.fn() } },
      moduleGraph: { idToModuleMap: new Map(), invalidateModule: vi.fn() },
      watcher: {
        add: vi.fn(),
        on: (event: string, handler: (file: string) => void) => handlers.set(event, handler),
      },
      ws: { send },
    })
    await writeFile(template, "Updated template")
    handlers.get("change")?.(template)

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(await readFile(join(root, ".vitehub", "email", "templates", "monthly-recap.mjs"), "utf8"))
      .toContain("Updated template")
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

  it("marks the package as noExternal for server environments", async () => {
    const plugin = hubEmail({ driver: "unemail/driver/resend" })
    const config = plugin.config as (config: { ssr?: { noExternal?: string[] } }) => Promise<unknown>
    const configEnvironment = plugin.configEnvironment as (name: string, config: { consumer?: string; resolve?: { noExternal?: string[] } }) => unknown

    expect(await config({})).toEqual({ ssr: { noExternal: ["@vite-hub/email"] } })
    expect(await config({ ssr: { noExternal: ["existing"] } })).toEqual({
      ssr: { noExternal: ["existing", "@vite-hub/email"] },
    })
    expect(configEnvironment("client", {})).toBeUndefined()
    expect(configEnvironment("ssr", {})).toEqual({
      resolve: { noExternal: ["@vite-hub/email"] },
    })
  })

})
