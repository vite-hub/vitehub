import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CHANNELS_REGISTRY_ID, hubChannels } from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-channels-vite-"))
  tempDirs.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }))
  return root
}

async function writeAgent(root: string, path: string): Promise<string> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, "export default { channels: { teams: { global: true, send: async () => ({ id: 'fixture-1' }) } } }\n")
  return file
}

async function resolvePlugin(plugin: ReturnType<typeof hubChannels>, root: string): Promise<void> {
  await (plugin.configResolved as (config: { root: string }) => void)({ root })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubChannels", () => {
  it("aliases Agent definitions into the global Channel registry in Nitro builds", async () => {
    const root = await createTempProject()
    const definition = await writeAgent(root, "server/agents/bot/agent.ts")
    const plugin = hubChannels()
    const result = await (plugin.config as unknown as (config: Record<PropertyKey, unknown>) => Promise<Record<string, unknown>>)({
      root,
      nitro: { externals: { inline: ["existing-package"], trace: false } },
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
    })
    const alias = (result.nitro as { alias: Record<string, string> }).alias
    const externals = (result.nitro as { externals: { inline: string[], trace: boolean } }).externals
    const registryFile = alias["#vitehub/channels/registry"]!

    expect(externals).toEqual({ inline: ["existing-package", "vite-hub", "@vite-hub/channels"], trace: false })
    await expect(readFile(registryFile, "utf8")).resolves.toContain(JSON.stringify(definition))

    await resolvePlugin(plugin, root)
    const addedDefinition = await writeAgent(root, "server/agents/other/agent.ts")
    await (plugin.handleHotUpdate as (context: unknown) => void)({
      file: addedDefinition,
      server: {
        config: { root },
        moduleGraph: { getModuleById: vi.fn() },
      },
    })

    await expect(readFile(registryFile, "utf8")).resolves.toContain(JSON.stringify(addedDefinition))
  })

  it("serves Agent definitions through a stable virtual module", async () => {
    const root = await createTempProject()
    const definition = await writeAgent(root, "server/agents/bot/agent.ts")
    const plugin = hubChannels()

    await resolvePlugin(plugin, root)

    expect((plugin.resolveId as (id: string) => string | undefined)(CHANNELS_REGISTRY_ID)).toBe(`\0${CHANNELS_REGISTRY_ID}`)
    expect((plugin.load as (id: string) => string | undefined)(`\0${CHANNELS_REGISTRY_ID}`)).toContain(JSON.stringify(definition))
    expect(plugin.api.getDefinitions()).toEqual([expect.objectContaining({ name: "bot" })])
  })

  it("preserves prototype-like Agent names in the generated registry", async () => {
    const root = await createTempProject()
    await writeAgent(root, "server/agents/__proto__/agent.ts")
    const plugin = hubChannels()

    await resolvePlugin(plugin, root)

    const registry = (plugin.load as (id: string) => string)(`\0${CHANNELS_REGISTRY_ID}`)
    expect(registry).toContain("const registry = Object.create(null)")
    expect(registry).toContain('registry["__proto__"] =')
  })

  it("refreshes and invalidates the virtual registry on Agent changes", async () => {
    const root = await createTempProject()
    const plugin = hubChannels()
    await resolvePlugin(plugin, root)
    const definition = await writeAgent(root, "src/alerts.agent.ts")
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

  it("refreshes Agent definitions from configured server directories", async () => {
    const root = await createTempProject()
    const serverDir = join(root, "custom-server")
    const plugin = hubChannels()
    ;(plugin.config as unknown as (config: Record<PropertyKey, unknown>) => void)({ [VITEHUB_SERVER_DIRS]: [serverDir] })
    await resolvePlugin(plugin, root)
    const definition = await writeAgent(root, "custom-server/agents/alerts/agent.ts")

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
