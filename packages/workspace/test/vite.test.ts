import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const tempDirs: string[] = []

async function createViteRoot() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-vite-"))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "src"), { recursive: true })
  await mkdir(join(rootDir, "workspaces"), { recursive: true })
  await writeFile(join(rootDir, "src/docs.workspace.ts"), [
    `import { defineWorkspace } from "@vitehub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  await writeFile(join(rootDir, "workspaces/legacy.ts"), [
    `import { defineWorkspace } from "@vitehub/workspace"`,
    `export default defineWorkspace({})`,
    ``,
  ].join("\n"))
  return rootDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("hubWorkspace", () => {
  it("attaches Nitro, noExternal, and virtual workspace manifests", async () => {
    const root = await createViteRoot()
    const { hubWorkspace } = await import("../src/vite.ts")
    const plugin = hubWorkspace()
    const configResolved = plugin.configResolved as (config: { root: string }) => Promise<void>
    const configEnvironment = plugin.configEnvironment as (name: string, environment: { consumer: "client" | "server", resolve?: { noExternal?: string[] } }) => unknown
    const resolveId = plugin.resolveId as (id: string) => string | undefined
    const load = plugin.load as (id: string) => string | undefined

    await configResolved({ root } as never)

    expect(plugin.nitro.name).toBe("@vitehub/workspace")
    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({
      resolve: { noExternal: ["@vitehub/workspace"] },
    })

    const rootId = resolveId("virtual:vitehub/workspaces")!
    expect(load(rootId)).toContain('"docs"')
    expect(load(rootId)).not.toContain('"legacy"')
    const docsId = resolveId("virtual:vitehub/workspaces/docs")!
    expect(load(docsId)).toContain('"entries":[]')
    const registryId = resolveId("#vitehub-workspace-registry")!
    expect(load(registryId)).toContain('"docs": async () => import(')
  })
})
