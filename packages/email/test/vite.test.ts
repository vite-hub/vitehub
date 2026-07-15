import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

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

afterEach(async () => {
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
