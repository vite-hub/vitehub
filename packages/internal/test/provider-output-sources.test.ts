import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { retainProviderOutputAliases, retainProviderOutputSources } from "../src/build/provider-output-sources.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

it("retains absolute alias keys with their copied source trees", () => {
  const aliases = retainProviderOutputAliases({
    "/app/src": "/app/replacements",
    "#server": "/app/server.ts",
  }, {
    resolve: path => path.startsWith("/app/") ? path.replace("/app/", "/retained/") : path,
  })

  expect(aliases).toEqual({
    "/app/src": "/retained/replacements",
    "/retained/src": "/retained/replacements",
    "#server": "/retained/server.ts",
  })
})

it("preserves the first alias when absolute keys share a retained path", () => {
  const aliases = retainProviderOutputAliases({
    "/project/src": "/project/first",
    "/project/a/../src": "/project/second",
    "/project/src/__vitehub_alias_prefix__0": "/project/first/",
    "/project/a/../src/__vitehub_alias_prefix__1": "/project/second/",
  }, {
    resolve: path => path.replace("/project/a/../", "/project/").replace("/project/", "/retained/"),
  })

  expect(aliases["/retained/src"]).toBe("/retained/first")
  expect(aliases["/retained/src/__vitehub_alias_prefix__0"]).toBe("/retained/first/")
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

it("excludes nested generated output directories from retained workspaces", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-nested-output-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const handler = join(rootDir, "server.ts")
  const generatedTest = join(workspace, "packages", "workflow", "examples", "vite", ".vitehub", "workflow", "sources", "test.ts")
  const temporaryTest = join(workspace, "playground", "vite", ".vitest-tmp", "project", "test.ts")
  await Promise.all([mkdir(rootDir, { recursive: true }), mkdir(dirname(generatedTest), { recursive: true }), mkdir(dirname(temporaryTest), { recursive: true })])
  await Promise.all([
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, "export default {}\n"),
    writeFile(generatedTest, "throw new Error('generated test must not be retained')\n"),
    writeFile(temporaryTest, "throw new Error('temporary test must not be retained')\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [handler],
    roots: [rootDir],
  })
  const retainedWorkspace = dirname(dirname(retained.resolve(handler)))

  await expect(readFile(retained.resolve(handler), "utf8")).resolves.toContain("export default")
  await expect(readFile(join(retainedWorkspace, "packages", "workflow", "examples", "vite", ".vitehub", "workflow", "sources", "test.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(join(retainedWorkspace, "playground", "vite", ".vitest-tmp", "project", "test.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("retains configured roots beneath nested generated output directories", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-nested-root-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, ".vitest-tmp", "project")
  const handler = join(rootDir, "server", "workflows", "support.ts")
  const shared = join(rootDir, "server", "shared.ts")
  const nestedGenerated = join(rootDir, ".vitehub", "workflow", "sources", "stale.ts")
  const nestedTemporary = join(rootDir, ".vitest-tmp", "stale.ts")
  const unrelated = join(workspace, "packages", "workflow", ".vitehub", "workflow", "sources", "test.ts")
  await Promise.all([
    mkdir(dirname(handler), { recursive: true }),
    mkdir(dirname(nestedGenerated), { recursive: true }),
    mkdir(dirname(nestedTemporary), { recursive: true }),
    mkdir(dirname(unrelated), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, 'export { value } from "../../shared"\n'),
    writeFile(shared, 'export const value = "retained"\n'),
    writeFile(nestedGenerated, "throw new Error('generated descendant must not be retained')\n"),
    writeFile(nestedTemporary, "throw new Error('temporary descendant must not be retained')\n"),
    writeFile(unrelated, "throw new Error('generated test must not be retained')\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [handler],
    roots: [rootDir],
  })
  const retainedWorkspace = join(retained.resolve(rootDir), "..", "..")

  await expect(readFile(retained.resolve(handler), "utf8")).resolves.toContain("../../shared")
  await expect(readFile(retained.resolve(shared), "utf8")).resolves.toContain("retained")
  await expect(readFile(retained.resolve(nestedGenerated), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(retained.resolve(nestedTemporary), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(join(retainedWorkspace, "packages", "workflow", ".vitehub", "workflow", "sources", "test.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("retains sibling dependencies for configured roots beneath ignored directories", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-ignored-root-sibling-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, ".vitest-tmp", "project", "vite")
  const handler = join(rootDir, "server", "workflows", "support.ts")
  const shared = join(workspace, ".vitest-tmp", "project", "_shared", "support.ts")
  const siblingGenerated = join(workspace, ".vitest-tmp", "project", "_shared", ".vitehub", "data", "secret.txt")
  const siblingIgnored = [
    join(workspace, ".vitest-tmp", "project", "_shared", ".git", "config"),
    join(workspace, ".vitest-tmp", "project", "_shared", ".vercel", "output", "config.json"),
    join(workspace, ".vitest-tmp", "project", "_shared", "dist", "secret.js"),
  ]
  const nestedGenerated = join(rootDir, ".vitehub", "workflow", "sources", "stale.ts")
  await Promise.all([handler, shared, siblingGenerated, ...siblingIgnored, nestedGenerated].map(file => mkdir(dirname(file), { recursive: true })))
  await Promise.all([
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, 'export { value } from "../../../_shared/support"\n'),
    writeFile(shared, 'export const value = "retained"\n'),
    writeFile(siblingGenerated, "local data must not be retained\n"),
    ...siblingIgnored.map(file => writeFile(file, "ignored output must not be retained\n")),
    writeFile(nestedGenerated, "throw new Error('generated descendant must not be retained')\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [handler],
    roots: [rootDir],
  })

  await expect(readFile(retained.resolve(shared), "utf8")).resolves.toContain("retained")
  await expect(readFile(retained.resolve(siblingGenerated), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await Promise.all(siblingIgnored.map(file => expect(readFile(retained.resolve(file), "utf8")).rejects.toMatchObject({ code: "ENOENT" })))
  await expect(readFile(retained.resolve(nestedGenerated), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("excludes ignored output directories beneath a configured closure root", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-standalone-root-"))
  tempDirs.push(rootDir)
  const handler = join(rootDir, "server", "workflow.ts")
  const ignoredFiles = [
    join(rootDir, ".git", "config"),
    join(rootDir, ".vercel", "output", "config.json"),
    join(rootDir, ".nuxt", "manifest.json"),
    join(rootDir, ".output", "server", "index.mjs"),
    join(rootDir, ".vitehub", "workflow", "sources", "stale.ts"),
    join(rootDir, ".vitest-tmp", "project", "test.ts"),
    join(rootDir, "coverage", "coverage.json"),
    join(rootDir, "dist", "index.js"),
  ]
  await Promise.all([mkdir(dirname(handler), { recursive: true }), ...ignoredFiles.map(file => mkdir(dirname(file), { recursive: true }))])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, "export default {}\n"),
    ...ignoredFiles.map(file => writeFile(file, "stale\n")),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [handler],
    roots: [rootDir],
  })

  await expect(readFile(retained.resolve(handler), "utf8")).resolves.toContain("export default")
  await Promise.all(ignoredFiles.map(file => expect(readFile(retained.resolve(file), "utf8")).rejects.toMatchObject({ code: "ENOENT" })))
})

it("excludes dependency trees nested beneath workspace packages", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-nested-dependencies-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "apps", "web")
  const handler = join(rootDir, "server", "workflow.ts")
  const nestedDependency = join(workspace, "packages", "docs", "node_modules", "fixture-dependency", "index.d.ts")
  await Promise.all([
    mkdir(dirname(handler), { recursive: true }),
    mkdir(dirname(nestedDependency), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n"),
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, "export default {}\n"),
    writeFile(nestedDependency, "export interface StaleDependency {}\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [handler],
    roots: [rootDir],
  })

  await expect(readFile(retained.resolve(handler), "utf8")).resolves.toContain("export default")
  await expect(readFile(retained.resolve(nestedDependency), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("retains relative dependencies beside a requested output entry", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-requested-output-"))
  tempDirs.push(rootDir)
  const entry = join(rootDir, "dist", "index.js")
  const chunk = join(rootDir, "dist", "chunk.js")
  const unrelatedOutput = join(rootDir, ".output", "server", "index.mjs")
  await Promise.all([mkdir(dirname(entry), { recursive: true }), mkdir(dirname(unrelatedOutput), { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "./chunk.js"\n'),
    writeFile(chunk, 'export const value = "retained"\n'),
    writeFile(unrelatedOutput, "export default {}\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
  await expect(readFile(retained.resolve(unrelatedOutput), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("scopes markerless generated inputs to their provider output", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-markerless-output-"))
  tempDirs.push(rootDir)
  const entry = join(rootDir, ".vitehub", "database", "schema", "default.ts")
  const chunk = join(rootDir, ".vitehub", "database", "schema", "chunk.ts")
  const unrelatedWorkflow = join(rootDir, ".vitehub", "workflow", "sources", "stale.ts")
  const unrelatedData = join(rootDir, ".vitehub", "data", "database", "sqlite.db")
  await Promise.all([entry, chunk, unrelatedWorkflow, unrelatedData].map(file => mkdir(dirname(file), { recursive: true })))
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(entry, 'export { value } from "./chunk"\n'),
    writeFile(chunk, 'export const value = "retained"\n'),
    writeFile(unrelatedWorkflow, "throw new Error('unrelated output must not be retained')\n"),
    writeFile(unrelatedData, "local data must not be retained\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "database-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(readFile(retained.resolve(entry), "utf8")).resolves.toContain("./chunk")
  await expect(readFile(retained.resolve(chunk), "utf8")).resolves.toContain("retained")
  await expect(readFile(retained.resolve(unrelatedWorkflow), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(retained.resolve(unrelatedData), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("preserves aliases that import above a directory named sources", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-custom-alias-"))
  tempDirs.push(rootDir)
  const entry = join(rootDir, ".vitehub", "custom", "sources", "entry.mjs")
  const shared = join(rootDir, ".vitehub", "custom", "shared.mjs")
  const unrelated = join(rootDir, ".vitehub", "workflow", "sources", "stale.mjs")
  await Promise.all([entry, shared, unrelated].map(file => mkdir(dirname(file), { recursive: true })))
  await Promise.all([
    writeFile(join(rootDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "../shared.mjs"\n'),
    writeFile(shared, 'export const value = "retained"\n'),
    writeFile(unrelated, "throw new Error('unrelated output must not be retained')\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
  await expect(readFile(retained.resolve(unrelated), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
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

it("retains package siblings imported by an aliased output entry", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "vitehub-provider-package-output-"))
  tempDirs.push(workspace)
  const rootDir = join(workspace, "app")
  const packageDir = join(workspace, "package")
  const entry = join(packageDir, "dist", "index.js")
  const asset = join(packageDir, "assets", "value.js")
  await Promise.all([mkdir(rootDir, { recursive: true }), mkdir(dirname(entry), { recursive: true }), mkdir(dirname(asset), { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(join(packageDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "../assets/value.js"\n'),
    writeFile(asset, 'export const value = "retained"\n'),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
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
  const entry = join(rootDir, ".vitehub", "blob-generations", "one", "sources", "runtime.mjs")
  const dependency = join(workspace, "packages", "blob", "dist", "runtime.js")
  const unrelatedOutput = join(rootDir, ".vitehub", "workflow", "sources", "stale.ts")
  await Promise.all([mkdir(dirname(entry), { recursive: true }), mkdir(dirname(dependency), { recursive: true }), mkdir(dirname(unrelatedOutput), { recursive: true })])
  await Promise.all([
    writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n"),
    writeFile(join(rootDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "../../../../../packages/blob/dist/runtime.js"\n'),
    writeFile(dependency, 'export const value = "retained"\n'),
    writeFile(unrelatedOutput, "throw new Error('unrelated output must not be retained')\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "queue-generations", "one", "runtime-sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
  await expect(readFile(retained.resolve(unrelatedOutput), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("retains only the requested UUID generation for a generated runtime alias", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-generation-alias-"))
  tempDirs.push(rootDir)
  const entry = join(rootDir, ".vitehub", "blob-generations", "requested", "vercel-runtime.mjs")
  const dependency = join(dirname(entry), "runtime-chunk.mjs")
  const stale = join(rootDir, ".vitehub", "blob-generations", "stale", "vercel-runtime.mjs")
  await Promise.all([mkdir(dirname(entry), { recursive: true }), mkdir(dirname(stale), { recursive: true })])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "./runtime-chunk.mjs"\n'),
    writeFile(dependency, 'export const value = "retained"\n'),
    writeFile(stale, "throw new Error('stale generation must not be retained')\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "queue-generations", "one", "runtime-sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
  await expect(readFile(retained.resolve(stale), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
})

it("preserves the import base for nested generation-like aliases", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-nested-generation-alias-"))
  tempDirs.push(rootDir)
  const entry = join(rootDir, ".vitehub", "custom", "tool-generations", "one", "runtime.mjs")
  const shared = join(rootDir, ".vitehub", "custom", "shared.mjs")
  const stale = join(rootDir, ".vitehub", "blob-generations", "stale", "vercel-runtime.mjs")
  await Promise.all([entry, shared, stale].map(file => mkdir(dirname(file), { recursive: true })))
  await Promise.all([
    writeFile(join(rootDir, "package.json"), '{"type":"module"}\n'),
    writeFile(entry, 'export { value } from "../../shared.mjs"\n'),
    writeFile(shared, 'export const value = "retained"\n'),
    writeFile(stale, "throw new Error('stale generation must not be retained')\n"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "queue-generations", "one", "runtime-sources"),
    paths: [entry],
    roots: [rootDir],
  })

  await expect(import(pathToFileURL(retained.resolve(entry)).href)).resolves.toMatchObject({ value: "retained" })
  await expect(readFile(retained.resolve(stale), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
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

it("ignores dangling optional dependency links while retaining provider sources", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-provider-optional-dependency-"))
  tempDirs.push(rootDir)
  const handler = join(rootDir, "server", "workflow.ts")
  const dependencyScope = join(rootDir, "node_modules", "@fixture")
  const danglingDependency = join(dependencyScope, "optional-platform-package")
  await Promise.all([
    mkdir(dirname(handler), { recursive: true }),
    mkdir(dependencyScope, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(rootDir, "package.json"), "{}\n"),
    writeFile(handler, "export default {}\n"),
    symlink(join(rootDir, "missing-optional-platform-package"), danglingDependency, process.platform === "win32" ? "junction" : "dir"),
  ])

  const retained = await retainProviderOutputSources({
    artifactDir: join(rootDir, ".vitehub", "workflow-generations", "one", "sources"),
    paths: [handler],
    roots: [rootDir],
  })

  await expect(readFile(retained.resolve(handler), "utf8")).resolves.toContain("export default")
  await expect(readFile(retained.resolve(danglingDependency), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
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
