import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { env } from "@vite-hub/env"
import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { mergeConfig } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CONNECTIONS_RUNTIME_ID, CONNECTIONS_VITE_PLUGIN_NAME, hubConnections } from "../src/vite.ts"

import type { ViteHubCliContributor, ViteHubCliContributorFactory } from "@vite-hub/internal/cli"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-connections-vite-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  return root
}

async function writeConnection(root: string, path: string): Promise<string> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, "export default { provider: { kind: 'oauth2', id: 'fixture', scopes: [] } }\n")
  return file
}

async function resolvePlugin(plugin: ReturnType<typeof hubConnections>, root: string): Promise<void> {
  await (plugin.configResolved as (config: { root: string }) => Promise<void>)({ root })
}

function load(plugin: ReturnType<typeof hubConnections>): string {
  return (plugin.load as (id: string) => string)(`\0${CONNECTIONS_RUNTIME_ID}`)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubConnections", () => {
  it("serves the generated runtime through a stable virtual module", async () => {
    const root = await createTempProject()
    const definition = await writeConnection(root, "server/connections/gmail.ts")
    const plugin = hubConnections({ runtimeEnvImport: "/virtual/env-server.js" })

    await resolvePlugin(plugin, root)

    expect(plugin.name).toBe(CONNECTIONS_VITE_PLUGIN_NAME)
    expect((plugin.resolveId as (id: string) => string | undefined)(CONNECTIONS_RUNTIME_ID)).toBe(`\0${CONNECTIONS_RUNTIME_ID}`)
    expect((plugin.resolveId as (id: string) => string | undefined)("other")).toBeUndefined()
    expect((plugin.load as (id: string) => string | undefined)("other")).toBeUndefined()
    const runtime = load(plugin)
    expect(runtime).toContain(`registry["gmail"] = () => import(${JSON.stringify(definition)})`)
    expect(runtime).toContain("const registry = Object.create(null)")
    expect(runtime).toContain(`import { databases as vitehubConnectionsDatabases } from "@vite-hub/database/drizzle"`)
    expect(runtime).toContain(`import { resolveServerEnv as vitehubConnectionsEnv } from "/virtual/env-server.js"`)
    expect(runtime).toContain(`database: () => vitehubConnectionsDatabases["default"]?.db,`)
    expect(runtime).toContain("encryptionKey: (event) => vitehubConnectionsEnv(keys, event).key?.unseal(),")
    expect(runtime).toContain("VITEHUB_CONNECTIONS_KEY")
    expect(plugin.api.getDefinitions()).toEqual([{ handler: definition, name: "gmail", source: "server-connections" }])
  })

  it("writes Connection name types", async () => {
    const root = await createTempProject()
    const definition = await writeConnection(root, "server/connections/gmail.ts")
    const plugin = hubConnections()

    await resolvePlugin(plugin, root)

    const types = await readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8")
    expect(types).toContain("interface ViteHubConnectionDefinitionModules {")
    expect(types).toContain(`"gmail": typeof import(${JSON.stringify(definition)})`)
    expect(types).toContain("export {}")
  })

  it("uses the configured database and key source", async () => {
    const root = await createTempProject()
    const plugin = hubConnections({
      database: "analytics",
      encryptionKey: env({ secret: true, source: env.source("APP_CONNECTIONS_KEY") }),
    })

    await resolvePlugin(plugin, root)

    const runtime = load(plugin)
    expect(runtime).toContain(`vitehubConnectionsDatabases["analytics"]?.db`)
    expect(runtime).toContain("APP_CONNECTIONS_KEY")
    expect(runtime).not.toContain("VITEHUB_CONNECTIONS_KEY")
  })

  it("aliases the generated runtime into Nitro builds and inlines the package", async () => {
    const root = await createTempProject()
    const definition = await writeConnection(root, "server/connections/gmail.ts")
    const plugin = hubConnections()
    const config = plugin.config as unknown as (config: Record<PropertyKey, unknown>) => Promise<Record<string, unknown>>
    const input = {
      root,
      ssr: { noExternal: ["existing-package", "@vite-hub/connections"] },
      nitro: { alias: { existing: "/existing.ts" }, externals: { inline: ["existing-package"], trace: false } },
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
    }
    const result = mergeConfig(input, await config(input))
    const nitro = result.nitro as { alias: Record<string, string>, externals: { inline: string[], trace: boolean } }
    const runtimeFile = nitro.alias[CONNECTIONS_RUNTIME_ID]!

    expect(runtimeFile).toBe(join(root, ".vitehub/nitro/connections/runtime.ts"))
    expect(nitro.alias.existing).toBe("/existing.ts")
    expect(nitro.externals).toEqual({ inline: ["existing-package", "vite-hub", "@vite-hub/connections"], trace: false })
    expect(result.ssr).toEqual({ noExternal: ["existing-package", "@vite-hub/connections"] })
    await expect(readFile(runtimeFile, "utf8")).resolves.toContain(JSON.stringify(definition))

    await resolvePlugin(plugin, root)
    const added = await writeConnection(root, "server/connections/drive.ts")
    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: added,
      server: { config: { root }, moduleGraph: { getModuleById: vi.fn() } },
    })
    await expect(readFile(runtimeFile, "utf8")).resolves.toContain(JSON.stringify(added))
  })

  it("keeps Nitro inline externals when they are already true", async () => {
    const root = await createTempProject()
    const plugin = hubConnections()
    const config = plugin.config as unknown as (config: Record<PropertyKey, unknown>) => Promise<Record<string, unknown>>
    const input = { root, nitro: { externals: { inline: true } }, [VITEHUB_NITRO_CONFIG_CONTEXT]: true }
    const result = mergeConfig(input, await config(input))

    expect((result.nitro as { externals: { inline: boolean } }).externals.inline).toBe(true)
  })

  it("does not configure Nitro outside a Nitro build", async () => {
    const root = await createTempProject()
    const plugin = hubConnections()
    const config = plugin.config as unknown as (config: Record<PropertyKey, unknown>) => Promise<Record<string, unknown>>

    expect((await config({ root })).nitro).toBeUndefined()
  })

  it("refreshes and invalidates the virtual runtime on definition changes", async () => {
    const root = await createTempProject()
    const plugin = hubConnections()
    await resolvePlugin(plugin, root)
    const definition = await writeConnection(root, "server/connections/gmail.ts")
    const virtualModule = {}
    const invalidateModule = vi.fn()
    const getModuleById = vi.fn(() => virtualModule)

    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: definition,
      server: { config: { root }, moduleGraph: { getModuleById, invalidateModule } },
    })

    expect(getModuleById).toHaveBeenCalledWith(`\0${CONNECTIONS_RUNTIME_ID}`)
    expect(invalidateModule).toHaveBeenCalledWith(virtualModule)
    expect(plugin.api.getDefinitions()).toEqual([expect.objectContaining({ name: "gmail" })])
    await expect(readFile(join(root, ".vitehub/types/connections.d.ts"), "utf8")).resolves.toContain("\"gmail\"")
  })

  it("ignores changes outside Connection directories", async () => {
    const root = await createTempProject()
    const plugin = hubConnections()
    await resolvePlugin(plugin, root)
    const getModuleById = vi.fn()

    for (const file of [join(root, "server/channels/alerts.ts"), join(root, "server/connections/readme.md")]) {
      await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
        file,
        server: { config: { root }, moduleGraph: { getModuleById } },
      })
    }

    expect(getModuleById).not.toHaveBeenCalled()
  })

  it("refreshes definitions from configured server directories", async () => {
    const root = await createTempProject()
    const serverDir = join(root, "custom-server")
    const plugin = hubConnections()
    await (plugin.config as unknown as (config: Record<PropertyKey, unknown>) => Promise<unknown>)({ [VITEHUB_SERVER_DIRS]: [serverDir] })
    await resolvePlugin(plugin, root)
    const definition = await writeConnection(root, "custom-server/connections/gmail.mts")

    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: definition,
      server: { config: { root }, moduleGraph: { getModuleById: vi.fn() } },
    })

    expect(plugin.api.getDefinitions()).toEqual([expect.objectContaining({ name: "gmail" })])
  })

  it("rejects an encryption key that is not a secret", () => {
    expect(() => hubConnections({ encryptionKey: env({ source: env.source("VITEHUB_CONNECTIONS_KEY") }) }))
      .toThrow("connections.encryptionKey must be a secret env() declaration")
  })

  it("rejects an encryption key from env.provider()", () => {
    expect(() => hubConnections({ encryptionKey: env({ secret: true, source: env.provider("secrets", "connections-key") }) }))
      .toThrow("connections.encryptionKey cannot use env.provider()")
  })

  it("rejects an encryption key with a default", () => {
    expect(() => hubConnections({ encryptionKey: env({ default: "not-in-build-output", secret: true }) }))
      .toThrow("connections.encryptionKey cannot have a default")
  })

  it("exposes the connections CLI namespace", async () => {
    const plugin = hubConnections()
    const cli = plugin.vitehub.cli as ViteHubCliContributorFactory
    const contributor = await cli() as ViteHubCliContributor

    expect(contributor.namespaces.map(namespace => namespace.name)).toEqual(["connections"])
    expect(contributor.namespaces[0]!.features.map(feature => feature.name)).toEqual([
      "list",
      "status",
      "activity",
      "connect",
      "refresh",
      "disconnect",
    ])
  })
})
