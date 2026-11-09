import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it, vi } from "vitest"

const { traceBuild } = vi.hoisted(() => ({ traceBuild: vi.fn<typeof import("esbuild").build>() }))
vi.mock("esbuild", async (importOriginal) => {
  const original = await importOriginal<typeof import("esbuild")>()
  traceBuild.mockImplementation(original.build)
  return { ...original, build: traceBuild }
})

import { retainProviderOutputSources } from "../src/build/provider-output-sources.ts"
import { bundleEsmEntry } from "../src/build/esbuild.ts"

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

it("retains dependencies recovered by retracing a shared module after a host variant fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-provider-trace-retry-"))
  roots.push(root)
  await mkdir(join(root, "server", "platform"), { recursive: true })
  await mkdir(join(root, "server", "lib"))
  await mkdir(join(root, "dist"))
  await writeFile(join(root, ".git"), "fixture boundary\n")
  await writeFile(join(root, "package.json"), '{"type":"module"}')
  await writeFile(join(root, "server", "entry.ts"), 'export { value } from "./shared.ts"; export { host } from "./platform"\n')
  await writeFile(join(root, "server", "shared.ts"), 'export { value } from "./lib"\n')
  await writeFile(join(root, "server", "platform", "package.json"), '{"main":"./node.ts","module":"./node.ts","type":"module"}')
  await writeFile(join(root, "server", "platform", "node.ts"), 'export const host = "node"\n')
  await writeFile(join(root, "server", "lib", "package.json"), '{"main":"./node.ts","module":"./index.ts","type":"module"}')
  await writeFile(join(root, "server", "lib", "node.ts"), 'export const value = "node"\n')
  await writeFile(join(root, "server", "lib", "index.ts"), 'export { value } from "../../dist/worker-value"\n')
  const target = join(root, "dist", "worker-value.ts")
  await writeFile(target, 'export const value = "worker"\n')

  const entry = join(root, "server", "entry.ts")
  const retained = await retainProviderOutputSources({
    artifactDir: join(root, ".vitehub", "sources"),
    paths: [entry],
    roots: [root],
  })
  await expect(readFile(retained.resolve(target), "utf8")).resolves.toContain('"worker"')
  const output = join(root, ".vitehub", "output.mjs")
  await bundleEsmEntry(retained.resolve(entry), output, {
    conditions: ["workerd", "worker", "browser", "default"],
    platform: "neutral",
    rootDir: retained.resolve(root),
  })
  await expect(import(pathToFileURL(output).href)).resolves.toMatchObject({ host: "node", value: "worker" })
})

it.each([
  'import Worker from "../dist/shared.ts?worker"; export { Worker }',
  'const target = "../dist/shared.ts"; export const load = () => import(target)',
])("retraces modules absent from some successful host variants: %s", async (request) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-provider-trace-variant-"))
  roots.push(root)
  await mkdir(join(root, "server", "platform"), { recursive: true })
  await mkdir(join(root, "dist", "lib"), { recursive: true })
  await writeFile(join(root, ".git"), "fixture boundary\n")
  await writeFile(join(root, "package.json"), '{"type":"module"}')
  const entry = join(root, "server", "entry.ts")
  const worker = join(root, "dist", "shared.ts")
  const target = join(root, "dist", "worker-value.ts")
  await writeFile(entry, `export { value } from "./platform"; ${request}\n`)
  await writeFile(join(root, "server", "platform", "package.json"), '{"main":"../../dist/shared.ts","module":"./index.ts","type":"module"}')
  await writeFile(join(root, "server", "platform", "index.ts"), 'export const value = "fallback"\n')
  await writeFile(worker, 'export { value } from "./lib"\n')
  await writeFile(join(root, "dist", "lib", "package.json"), '{"main":"./node.ts","module":"./index.ts","type":"module"}')
  await writeFile(join(root, "dist", "lib", "node.ts"), 'export const value = "node"\n')
  await writeFile(join(root, "dist", "lib", "index.ts"), 'export { value } from "../worker-value"\n')
  await writeFile(target, 'export const value = "worker"\n')

  const retained = await retainProviderOutputSources({ artifactDir: join(root, ".vitehub", "sources"), paths: [entry], roots: [root] })
  await expect(readFile(retained.resolve(target), "utf8")).resolves.toContain('"worker"')
  const output = join(root, ".vitehub", "worker.mjs")
  await bundleEsmEntry(retained.resolve(worker), output, {
    conditions: ["workerd", "worker", "browser", "default"],
    platform: "neutral",
    rootDir: retained.resolve(root),
  })
  await expect(import(pathToFileURL(output).href)).resolves.toMatchObject({ value: "worker" })
})
