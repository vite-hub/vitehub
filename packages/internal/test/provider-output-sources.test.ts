import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { retainProviderOutputSources } from "../src/build/provider-output-sources.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

it("retains a generation's source-root layout and generated dependencies", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-sources-"))
  tempDirs.push(rootDir)
  const handler = join(rootDir, "server", "agents", "support.ts")
  const shared = join(rootDir, "server", "shared.ts")
  const schema = join(rootDir, ".vitehub", "database", "schema.ts")
  await Promise.all([mkdir(join(rootDir, "server", "agents"), { recursive: true }), mkdir(join(rootDir, ".vitehub", "database"), { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, 'export { value } from "../shared"\n'),
    writeFile(shared, 'export const value = "old"\n'),
    writeFile(schema, 'export const schema = "old"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "agent-generations", "one", "sources"),
    paths: [handler, schema],
    roots: [rootDir],
  })
  await Promise.all([writeFile(shared, 'export const value = "new"\n'), writeFile(schema, 'export const schema = "new"\n')])

  await expect(readFile(join(dirname(dirname(retained.resolve(handler))), "shared.ts"), "utf8")).resolves.toContain("old")
  await expect(readFile(retained.resolve(schema), "utf8")).resolves.toContain("old")
})

it("excludes transient Drizzle generation directories from retained workspaces", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-transient-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const handler = join(rootDir, "server.ts")
  const transientFile = join(workspace, "packages", "database", "test", ".drizzle-generate-one", "migration.sql")
  await Promise.all([mkdir(rootDir, { recursive: true }), mkdir(dirname(transientFile), { recursive: true })])
  await Promise.all([
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, "export default {}\n"),
    writeFile(transientFile, "select 1;\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "agent-generations", "one", "sources"),
    paths: [handler],
    roots: [rootDir],
  })

  await expect(readFile(retained.resolve(handler), "utf8")).resolves.toContain("export default")
  await expect(readFile(join(dirname(dirname(retained.resolve(handler))), "packages", "database", "test", ".drizzle-generate-one", "migration.sql"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("retains explicitly requested sources in transient Drizzle generation directories", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-requested-transient-"))
  tempDirs.push(rootDir)
  const requestedFile = join(rootDir, ".drizzle-generate-one", "runtime.mjs")
  await mkdir(dirname(requestedFile), { recursive: true })
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(requestedFile, 'export const generation = "retained"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "database-generations", "one", "sources"),
    paths: [requestedFile],
    roots: [rootDir],
  })

  await expect(readFile(retained.resolve(requestedFile), "utf8")).resolves.toContain("retained")
})

it("retains an aliased package with its relative import base", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-alias-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const packageDir = join(workspace, "email")
  const alias = join(packageDir, "src", "definition.ts")
  const config = join(packageDir, "src", "config.ts")
  await Promise.all([mkdir(rootDir, { recursive: true }), mkdir(dirname(alias), { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), "{}\n"),
    writeFile(alias, 'export { value } from "./config"\n'),
    writeFile(config, 'export const value = "old"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "schedule-generations", "one", "sources"),
    paths: [alias],
    roots: [rootDir],
  })
  await writeFile(config, 'export const value = "new"\n')

  await expect(readFile(join(dirname(retained.resolve(alias)), "config.ts"), "utf8")).resolves.toContain("old")
})

it("retains sibling chunks behind an installed package alias", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-package-chunk-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const packageDir = join(rootDir, "node_modules", "fixture-package")
  const entry = join(packageDir, "dist", "index.js")
  const chunk = join(packageDir, "dist", "chunk.js")
  await mkdir(dirname(entry), { recursive: true })
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "./chunk.js"\n'),
    writeFile(chunk, 'export const value = "retained"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "agent-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })
  await writeFile(chunk, 'export const value = "changed"\n')

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
})

it("retains package closures behind an earlier retained source", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-nested-retained-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const packageDir = join(rootDir, ".vitehub", "queue-generations", "one", "sources", "2")
  const dependencyDir = join(rootDir, "node_modules", "fixture-dependency")
  const entry = join(packageDir, "dist", "index.js")
  const chunk = join(packageDir, "dist", "chunk.js")
  await Promise.all([mkdir(dirname(entry), { recursive: true }), mkdir(dependencyDir, { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "./chunk.js"\nexport { dependency } from "fixture-dependency"\n'),
    writeFile(chunk, 'export const value = "retained"\n'),
    writeFile(join(dependencyDir, "package.json"), '{"exports":"./index.js","type":"module"}\n'),
    writeFile(join(dependencyDir, "index.js"), 'export const dependency = "linked"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "queue-generations", "one", "runtime-sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({
    dependency: "linked",
    value: "retained",
  })
})

it("preserves workspace-relative imports from generated sources without their own package", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-generated-workspace-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const entry = join(rootDir, ".vitehub", "blob-generations", "one", "runtime.mjs")
  const dependency = join(workspace, "packages", "blob", "dist", "runtime.js")
  await Promise.all([mkdir(dirname(entry), { recursive: true }), mkdir(dirname(dependency), { recursive: true })])
  await Promise.all([
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
    writeFile(join(rootDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "../../../../packages/blob/dist/runtime.js"\n'),
    writeFile(dependency, 'export const value = "retained"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "queue-generations", "one", "runtime-sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
})

it("retains relative imports that escape a package-scoped Vite root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-workspace-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "apps", "web")
  const handler = join(rootDir, "server", "queues", "sync.ts")
  const shared = join(workspace, "packages", "shared", "src", "index.ts")
  await Promise.all([mkdir(dirname(handler), { recursive: true }), mkdir(dirname(shared), { recursive: true })])
  await Promise.all([
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n"),
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, 'export { value } from "../../../../packages/shared/src/index"\n'),
    writeFile(shared, 'export const value = "old"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "queue-generations", "one", "sources"),
    paths: [handler],
    roots: [rootDir],
  })
  await writeFile(shared, 'export const value = "new"\n')

  const retainedHandler = retained.resolve(handler)
  await expect(readFile(join(dirname(retainedHandler), "../../../../packages/shared/src/index.ts"), "utf8")).resolves.toContain("old")
  expect(retained.resolve(rootDir)).toBe(dirname(dirname(dirname(retainedHandler))))
})

it("preserves installed package dependency resolution", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-package-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const packageDir = join(rootDir, "node_modules", "fixture-package")
  const dependencyDir = join(rootDir, "node_modules", "fixture-dependency")
  const entry = join(packageDir, "dist", "index.js")
  await Promise.all([mkdir(dirname(entry), { recursive: true }), mkdir(dependencyDir, { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(rootDir, "node_modules", ".package-lock.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "fixture-dependency"\n'),
    writeFile(join(dependencyDir, "package.json"), '{"exports":"./index.js","type":"module"}\n'),
    writeFile(join(dependencyDir, "index.js"), 'export const value = "retained"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
})

it("preserves dependency resolution for a workspace-linked package", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-workspace-package-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "apps", "web")
  const packageDir = join(workspace, "packages", "fixture-package")
  const dependencyDir = join(workspace, "node_modules", "fixture-dependency")
  const entry = join(packageDir, "dist", "index.js")
  await Promise.all([mkdir(rootDir, { recursive: true }), mkdir(dirname(entry), { recursive: true }), mkdir(dependencyDir, { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "fixture-dependency"\n'),
    writeFile(join(dependencyDir, "package.json"), '{"exports":"./index.js","type":"module"}\n'),
    writeFile(join(dependencyDir, "index.js"), 'export const value = "retained"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
})

it("preserves workspace dependencies beyond a package-local dependency tree", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-workspace-dependencies-"))
  const artifactRoot = await mkdtemp(join(tmpdir(), "vitehub-provider-workspace-artifact-"))
  tempDirs.push(workspace, artifactRoot)
  const rootDir = join(workspace, "apps", "web")
  const packageDir = join(workspace, "packages", "fixture-package")
  const dependencyDir = join(workspace, "node_modules", "fixture-dependency")
  const entry = join(packageDir, "dist", "index.js")
  await Promise.all([
    mkdir(rootDir, { recursive: true }),
    mkdir(dirname(entry), { recursive: true }),
    mkdir(join(packageDir, "node_modules", "package-local-dependency"), { recursive: true }),
    mkdir(dependencyDir, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "fixture-dependency"\n'),
    writeFile(join(dependencyDir, "package.json"), '{"exports":"./index.js","type":"module"}\n'),
    writeFile(join(dependencyDir, "index.js"), 'export const value = "retained"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(artifactRoot, "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
})

it("preserves dependency resolution for packages installed in a pnpm store", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-pnpm-package-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const dependencyRoot = join(rootDir, "node_modules", ".pnpm", "fixture-package@1.0.0", "node_modules")
  const packageDir = join(dependencyRoot, "@fixture", "package")
  const dependencyDir = join(dependencyRoot, "fixture-dependency")
  const entry = join(packageDir, "dist", "index.js")
  await Promise.all([mkdir(dirname(entry), { recursive: true }), mkdir(dependencyDir, { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "fixture-dependency"\n'),
    writeFile(join(dependencyDir, "package.json"), '{"exports":"./index.js","type":"module"}\n'),
    writeFile(join(dependencyDir, "index.js"), 'export const value = "retained"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
})

it("preserves pnpm dependencies when the package entry uses its top-level symlink", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-pnpm-symlink-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const dependencyRoot = join(rootDir, "node_modules", ".pnpm", "fixture-package@1.0.0", "node_modules")
  const packageDir = join(dependencyRoot, "fixture-package")
  const dependencyDir = join(rootDir, "node_modules", ".pnpm", "fixture-dependency@1.0.0", "node_modules", "fixture-dependency")
  const entry = join(rootDir, "node_modules", "fixture-package", "dist", "index.js")
  await Promise.all([
    mkdir(join(packageDir, "dist"), { recursive: true }),
    mkdir(dependencyDir, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), '{"type":"module"}\n'),
    writeFile(join(packageDir, "dist", "index.js"), 'export { value } from "fixture-dependency"\n'),
    writeFile(join(dependencyDir, "package.json"), '{"exports":"./index.js","type":"module"}\n'),
    writeFile(join(dependencyDir, "index.js"), 'export const value = "retained"\n'),
    symlink("../../fixture-dependency@1.0.0/node_modules/fixture-dependency", join(dependencyRoot, "fixture-dependency"), process.platform === "win32" ? "junction" : "dir"),
    symlink(packageDir, join(rootDir, "node_modules", "fixture-package"), process.platform === "win32" ? "junction" : "dir"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
})
