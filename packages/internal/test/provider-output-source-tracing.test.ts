import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it, vi } from "vitest"

const { traceBuild } = vi.hoisted(() => ({ traceBuild: vi.fn<typeof import("esbuild").build>() }))
vi.mock("esbuild", async (importOriginal) => {
  const original = await importOriginal<typeof import("esbuild")>()
  traceBuild.mockImplementation(original.build)
  return { ...original, build: traceBuild }
})

import { retainProviderOutputSources } from "../src/build/provider-output-sources.ts"

const roots: string[] = []
afterEach(async () => {
  traceBuild.mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it("does not schedule another trace for static modules already read by the host variants", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-provider-trace-"))
  roots.push(root)
  const entry = join(root, "server", "entry.ts")
  const dependency = join(root, "server", "dependency.ts")
  await mkdir(join(root, "server"))
  await writeFile(join(root, "package.json"), '{"type":"module"}')
  await writeFile(entry, 'export { value } from "./dependency.ts"\n')
  await writeFile(dependency, 'export const value = "retained"\n')

  const retained = await retainProviderOutputSources({
    artifactDir: join(root, ".vitehub", "sources"),
    paths: [entry],
    roots: [root],
  })

  await expect(readFile(retained.resolve(dependency), "utf8")).resolves.toContain('"retained"')
  expect(traceBuild).toHaveBeenCalled()
  for (const [options] of traceBuild.mock.calls) expect(options.entryPoints).toEqual([entry])
})
