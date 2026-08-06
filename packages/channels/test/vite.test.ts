import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

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
  await writeFile(file, "export default { connectors: { fixture: { send: async () => ({ id: 'fixture-1' }) } } }\n")
  return file
}

async function resolvePlugin(plugin: ReturnType<typeof hubChannels>, root: string): Promise<void> {
  await (plugin.configResolved as (config: { root: string }) => void)({ root })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe("hubChannels", () => {
  it("serves a discovered registry through a stable virtual module", async () => {
    const root = await createTempProject()
    const definition = await writeChannel(root, "server/channels/alerts.ts")
    const plugin = hubChannels()

    await resolvePlugin(plugin, root)

    expect((plugin.resolveId as (id: string) => string | undefined)(CHANNELS_REGISTRY_ID)).toBe(`\0${CHANNELS_REGISTRY_ID}`)
    expect((plugin.load as (id: string) => string | undefined)(`\0${CHANNELS_REGISTRY_ID}`)).toContain(JSON.stringify(definition))
    expect(plugin.api.getDefinitions()).toEqual([expect.objectContaining({ name: "alerts" })])
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
})
