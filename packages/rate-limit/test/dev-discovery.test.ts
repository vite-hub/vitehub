import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseSync, resolveConfig } from "vite"
import { afterEach, expect, it, vi } from "vitest"

import { hubRateLimit } from "../src/vite.ts"
import { createRateLimitCatalogDiscovery } from "../src/discovery.ts"

vi.mock("vite", async (importOriginal) => {
  const vite = await importOriginal<typeof import("vite")>()
  return { ...vite, parseSync: vi.fn(vite.parseSync) }
})

const roots: string[] = []

afterEach(async () => {
  vi.mocked(parseSync).mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function guard(name: string, limit = 5): string {
  return `export function route(event) { return requireRateLimit(event, ${JSON.stringify(name)}, { limit: ${limit}, window: "1m" }) }\n`
}

it("isolates cached declarations from mutations to previous results", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-catalog-"))
  roots.push(root)
  await mkdir(join(root, "server"))
  const file = join(root, "server", "upload.ts")
  await writeFile(file, guard("upload"))
  const discover = createRateLimitCatalogDiscovery()
  const first = discover({ rootDir: root })
  const expected = structuredClone(first.declarations)
  for (const declaration of first.declarations) {
    declaration.name = "changed"
    declaration.policy.limit = 99
    declaration.source.file = "changed.ts"
  }
  first.declarationFiles.clear()
  first.declarations.length = 0
  vi.mocked(parseSync).mockClear()

  const second = discover({ rootDir: root })

  expect(second.declarations).toEqual(expected)
  expect(second.declarationFiles).toEqual(new Set([file]))
  expect(parseSync).not.toHaveBeenCalled()
})

async function project() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-dev-discovery-"))
  roots.push(root)
  await mkdir(join(root, "server"))
  await writeFile(join(root, "server", "upload.ts"), guard("upload"))
  await writeFile(join(root, "server", "helper.ts"), "export const helper = 1\n")
  const errors: string[] = []
  const plugin = hubRateLimit({ provider: "memory" })
  const config = await resolveConfig({ root, configFile: false, logLevel: "silent", plugins: [plugin] }, "serve")
  config.logger.error = message => { errors.push(message) }
  const manifest = async (): Promise<unknown> => JSON.parse(await readFile(join(root, ".vitehub", "rate-limit", "manifest.json"), "utf8"))
  const update = async (name: string) => {
    // SAFETY: This plugin implements the callable hook, and this test supplies the fields that it reads.
    const hook = plugin.handleHotUpdate as (context: unknown) => Promise<void>
    await hook({ file: join(root, "server", name), server: { config } })
  }
  return { errors, manifest, root, update }
}

it("does not parse unchanged guard modules during unrelated hot updates", async () => {
  const app = await project()
  vi.mocked(parseSync).mockClear()
  await writeFile(join(app.root, "server", "helper.ts"), "export const helper = 2\n")

  await app.update("helper.ts")

  expect(parseSync).not.toHaveBeenCalled()
  expect(await app.manifest()).toMatchObject({ rateLimits: [expect.objectContaining({ name: "upload" })] })
})

it("reads changed bytes and discovers additions and deletions on the next scan", async () => {
  const app = await project()
  vi.mocked(parseSync).mockClear()
  await writeFile(join(app.root, "server", "upload.ts"), guard("renamed", 9))
  await app.update("upload.ts")
  expect(parseSync).toHaveBeenCalledTimes(1)
  expect(await app.manifest()).toMatchObject({ rateLimits: [expect.objectContaining({ name: "renamed" })] })

  vi.mocked(parseSync).mockClear()
  await writeFile(join(app.root, "server", "search.ts"), guard("search"))
  await app.update("search.ts")
  expect(parseSync).toHaveBeenCalledTimes(1)
  expect(await app.manifest()).toMatchObject({ rateLimits: [expect.objectContaining({ name: "renamed" }), expect.objectContaining({ name: "search" })] })

  vi.mocked(parseSync).mockClear()
  await rm(join(app.root, "server", "upload.ts"))
  await app.update("helper.ts")
  expect(parseSync).not.toHaveBeenCalled()
  expect(await app.manifest()).toMatchObject({ rateLimits: [expect.objectContaining({ name: "search" })] })
})

it("rechecks conflicting policies against unchanged files and recovers after correction", async () => {
  const app = await project()
  vi.mocked(parseSync).mockClear()
  await writeFile(join(app.root, "server", "conflict.ts"), guard("upload", 8))
  await app.update("conflict.ts")
  expect(parseSync).toHaveBeenCalledTimes(1)
  expect(app.errors).toEqual([expect.stringContaining('Conflicting Rate Limit policies for ID "upload"')])
  expect(await app.manifest()).toMatchObject({ rateLimits: [expect.objectContaining({ name: "upload" })] })

  await writeFile(join(app.root, "server", "conflict.ts"), guard("upload"))
  await app.update("conflict.ts")
  expect(await app.manifest()).toMatchObject({ rateLimits: [expect.objectContaining({ name: "upload" })] })
  await rm(join(app.root, "server", "conflict.ts"))
  await writeFile(join(app.root, "server", "upload.ts"), guard("upload", 8))
  await app.update("upload.ts")
  expect(await app.manifest()).toMatchObject({ rateLimits: [expect.objectContaining({ name: "upload" })] })
})

it("does not retain failed extraction results", async () => {
  const app = await project()
  await writeFile(join(app.root, "server", "stable.ts"), guard("stable"))
  await app.update("stable.ts")
  vi.mocked(parseSync).mockClear()
  await writeFile(join(app.root, "server", "upload.ts"), 'requireRateLimit(event, "upload", { limit: dynamic, window: "1m" })\n')
  await app.update("upload.ts")
  expect(parseSync).toHaveBeenCalledTimes(1)
  vi.mocked(parseSync).mockClear()
  await app.update("helper.ts")
  expect(parseSync).toHaveBeenCalledTimes(1)
  expect(app.errors).toHaveLength(2)
  expect(app.errors.every(error => error.includes('option "limit" must be a static literal'))).toBe(true)

  await writeFile(join(app.root, "server", "upload.ts"), guard("recovered", 7))
  await app.update("upload.ts")
  expect(await app.manifest()).toMatchObject({ rateLimits: [expect.objectContaining({ name: "recovered" }), expect.objectContaining({ name: "stable" })] })
})
