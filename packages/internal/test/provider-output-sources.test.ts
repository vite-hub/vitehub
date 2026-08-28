import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
