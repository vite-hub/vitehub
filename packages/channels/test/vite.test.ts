import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveConfig } from "vite"

import { CHANNELS_REGISTRY_ID, hubChannels } from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-channels-vite-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  return root
}

async function writeChannel(root: string, path: string): Promise<string> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, "export default { adapter: { kind: 'fixture', send: async () => ({ id: 'fixture-1' }) } }\n")
  return file
}

async function resolvePlugin(plugin: ReturnType<typeof hubChannels>, root: string): Promise<void> {
  await (plugin.configResolved as (config: { root: string }) => void)({ root })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubChannels", () => {
  it("aliases the discovered Channel registry into Nitro builds", async () => {
    const root = await createTempProject()
    const definition = await writeChannel(root, "server/channels/alerts.ts")
    const plugin = hubChannels()
    const inlineConfig = {
      configFile: false as const,
      logLevel: "silent" as const,
      nitro: {
        cloudflare: { wrangler: { secrets: { required: ["VITEHUB_TOKEN"] } } },
        plugins: ["/app/plugin.ts"],
      },
      plugins: [plugin],
      root,
      ssr: { noExternal: ["existing"] },
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
    }
    const resolved = await resolveConfig(inlineConfig, "build")
    // SAFETY: Vite keeps the open `nitro` key of the inline config on its resolved config.
    const nitro = (resolved as typeof resolved & { nitro: { alias: Record<string, string>, cloudflare: { wrangler: { secrets: { required: string[] } } }, plugins: string[] } }).nitro
    const registryFile = nitro.alias["#vitehub/channels/registry"]!

    expect(nitro.cloudflare.wrangler.secrets.required).toEqual(["VITEHUB_TOKEN"])
    expect(nitro.plugins).toEqual(["/app/plugin.ts"])
    expect(resolved.ssr.noExternal).toEqual(["existing", "@vite-hub/channels"])
    expect(resolved.environments.ssr?.resolve.noExternal).toEqual(["existing", "@vite-hub/channels"])
    await expect(readFile(registryFile, "utf8")).resolves.toContain(JSON.stringify(definition))

    const addedDefinition = await writeChannel(root, "server/channels/incidents.ts")
    await (plugin.handleHotUpdate as (context: unknown) => void)({
      file: addedDefinition,
      server: {
        config: { root },
        moduleGraph: { getModuleById: vi.fn() },
      },
    })

    await expect(readFile(registryFile, "utf8")).resolves.toContain(JSON.stringify(addedDefinition))
  })

  it.each([
    ["server/channels/payments.ts", "import { defineChannel, stripe } from 'vite-hub/channels'\nexport default defineChannel({ adapter: stripe() })"],
    ["src/payments.channel.ts", "import * as channels from 'vite-hub/channels'\nexport default channels.defineChannel({ adapter: channels.stripe() })"],
    ["server/channels/payments.ts", "import * as channels from '@vite-hub/channels'\nexport default channels.defineChannel({ adapter: channels.webhook({ secret: false }) })"],
    ["server/channels/payments.ts", "import * as channels from '@vite-hub/channels'\nexport default channels.defineChannel({ adapter: channels['webhook']() })"],
  ])("requires the Agent plugin for inbound Channels in %s: %s", async (path, source) => {
    const root = await createTempProject()
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
    const configure = (plugins: Array<{ name: string }>) => (hubChannels().configResolved as unknown as (config: { plugins: Array<{ name: string }>, root: string }) => Promise<void>)({ plugins, root })

    await expect(configure([])).rejects.toMatchObject({ code: "CHANNELS_B0001", message: expect.stringContaining('The Channel "payments" receives webhooks') })
    await expect(configure([{ name: "@vite-hub/agent/vite" }])).resolves.toBeUndefined()
  })

  it("allows an outbound-only namespace import without the Agent plugin", async () => {
    const root = await createTempProject()
    const file = await writeChannel(root, "server/channels/alerts.ts")
    await writeFile(file, "import * as channels from '@vite-hub/channels'\nexport default channels.defineChannel({ adapter: { kind: 'log', send: () => ({}) } })\n")
    await expect(resolvePlugin(hubChannels(), root)).resolves.toBeUndefined()
  })

  it("serves a discovered registry through a stable virtual module", async () => {
    const root = await createTempProject()
    const definition = await writeChannel(root, "server/channels/alerts.ts")
    const plugin = hubChannels()

    await resolvePlugin(plugin, root)

    const resolveId = plugin.resolveId as { filter: { id: RegExp }, handler: (id: string) => string | undefined }
    const load = plugin.load as { filter: { id: RegExp }, handler: (id: string) => string | undefined }

    expect([CHANNELS_REGISTRY_ID, `${CHANNELS_REGISTRY_ID}.ts`, "@vite-hub/channels"].map(id => resolveId.filter.id.test(id))).toEqual([true, false, false])
    expect([`\0${CHANNELS_REGISTRY_ID}`, CHANNELS_REGISTRY_ID].map(id => load.filter.id.test(id))).toEqual([true, false])
    expect(resolveId.handler(CHANNELS_REGISTRY_ID)).toBe(`\0${CHANNELS_REGISTRY_ID}`)
    expect(load.handler(`\0${CHANNELS_REGISTRY_ID}`)).toContain(JSON.stringify(definition))
    expect(plugin.api.getDefinitions()).toEqual([expect.objectContaining({ name: "alerts" })])
    await expect(readFile(join(root, ".vitehub/types/channels.d.ts"), "utf8")).resolves.toContain(
      `"alerts": typeof import(${JSON.stringify(definition)})`,
    )
  })

  it("preserves prototype-like Channel names in the generated registry", async () => {
    const root = await createTempProject()
    await writeChannel(root, "server/channels/__proto__.ts")
    const plugin = hubChannels()

    await resolvePlugin(plugin, root)

    const registry = (plugin.load as { handler: (id: string) => string }).handler(`\0${CHANNELS_REGISTRY_ID}`)
    expect(registry).toContain("const registry = Object.create(null)")
    expect(registry).toContain('registry["__proto__"] =')
  })

  it("refreshes and invalidates the virtual registry on definition changes", async () => {
    const root = await createTempProject()
    const plugin = hubChannels()
    await resolvePlugin(plugin, root)
    const definition = await writeChannel(root, "src/alerts.channel.ts")
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

    expect(plugin.api.getDefinitions()).toEqual([expect.objectContaining({ name: "alerts" })])
    expect(invalidateModule).toHaveBeenCalledWith(virtualModule)
  })

  it("ignores inherited server directory configuration", async () => {
    const root = await createTempProject()
    await writeChannel(root, "server/channels/own.ts")
    const externalRoot = await mkdtemp(join(tmpdir(), "vitehub-channels-inherited-server-"))
    tempDirs.push(externalRoot)
    await writeChannel(externalRoot, "channels/inherited.ts")
    const plugin = hubChannels()
    const config = Object.create({ [VITEHUB_SERVER_DIRS]: [externalRoot] }) as Record<PropertyKey, unknown>

    await (plugin.config as unknown as (config: Record<PropertyKey, unknown>) => Promise<unknown>)(config)
    await resolvePlugin(plugin, root)

    expect(plugin.api.getDefinitions()).toEqual([expect.objectContaining({ name: "own" })])
  })

  it("refreshes directory definitions from configured server directories", async () => {
    const root = await createTempProject()
    const serverDir = join(root, "custom-server")
    const plugin = hubChannels()
    ;(plugin.config as unknown as (config: Record<PropertyKey, unknown>) => void)({ [VITEHUB_SERVER_DIRS]: [serverDir] })
    await resolvePlugin(plugin, root)
    const definition = await writeChannel(root, "custom-server/channels/alerts.tsx")

    await (plugin.handleHotUpdate as (context: unknown) => void)({
      file: definition,
      server: {
        config: { root },
        moduleGraph: { getModuleById: vi.fn() },
      },
    })

    expect(plugin.api.getDefinitions()).toEqual([expect.objectContaining({ name: "alerts" })])
  })
})
