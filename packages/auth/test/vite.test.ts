import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { AUTH_DEFINITION_ID, hubAuth } from "../src/vite.ts"

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-auth-vite-"))
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
