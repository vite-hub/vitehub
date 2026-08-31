import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, expect, it, vi } from "vitest"
import { useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"

const generateProviderOutputs = vi.fn(async (options: { appRootDir?: string }) => {
  return await readFile(join(options.appRootDir!, "src", "server.ts"), "utf8")
})

vi.mock("../src/internal/vite-build.ts", () => ({
  dbPackageName: "@vite-hub/database",
  generateProviderOutputs,
  prepareProviderOutputs: vi.fn(async () => ({})),
}))

const { hubDb } = await import("../src/vite.ts")
const tempDirs: string[] = []

afterEach(async () => {
  generateProviderOutputs.mockClear()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

it("finalizes Database Provider Output from the captured application root", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-retained-root-"))
  tempDirs.push(rootDir)
  const definition = join(rootDir, "server", "databases", "config.ts")
  const applicationEntry = join(rootDir, "src", "server.ts")
  await Promise.all([mkdir(dirname(definition), { recursive: true }), mkdir(dirname(applicationEntry), { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(definition, "export default { name: 'default', schema: {} }\n"),
    writeFile(applicationEntry, "captured application\n"),
  ])

  const plugin = hubDb()
  const config = { build: { outDir: "dist/client" }, command: "build", root: rootDir }
  await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
  const context = {}
  await Reflect.apply(plugin.buildStart as () => void, context, [])
  await Reflect.apply(plugin.buildEnd as () => Promise<void>, context, [])
  await writeFile(applicationEntry, "changed application\n")

  const [contribution] = useProviderOutputCatalog(config).takeDeploymentContributions()
  await contribution!.write({
    readCloudflareState: async () => ({ wranglerConfig: {} }),
    signal: new AbortController().signal,
    write: async () => undefined,
  })

  await expect(generateProviderOutputs.mock.results[0]?.value).resolves.toContain("captured application")
  expect(generateProviderOutputs.mock.calls[0]?.[0].appRootDir).not.toBe(rootDir)
})
