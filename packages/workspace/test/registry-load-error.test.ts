import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { Diagnostic } from "nostics"
import { afterEach, expect, it } from "vitest"

import { createWorkspaceRegistryContents } from "../src/build/discovery.ts"
import { resetWorkspaceRegistry, resolveRegisteredWorkspaceDefinition, setWorkspaceRegistry } from "../src/core/registry.ts"
import { workspaceRegistryDefinitions } from "../src/durability.ts"
import { workspaceErrorDiagnostics } from "../src/error-diagnostics.ts"

import type { DiscoveredWorkspaceDefinition } from "../src/build/discovery.ts"
import type { WorkspaceRegistry } from "../src/core/registry.ts"

const tempDirs: string[] = []

afterEach(async () => {
  resetWorkspaceRegistry()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

async function writeRegistry(eager: boolean) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-registry-load-"))
  tempDirs.push(root)
  const module = join(root, "owner", "workspace.mjs")
  await mkdir(join(root, "owner"), { recursive: true })
  await writeFile(module, "export const other = {}\n")
  const definition: DiscoveredWorkspaceDefinition = {
    contributor: "content-owner/vite",
    export: "contentWorkspace",
    handler: module,
    name: "content",
    path: module,
    source: "vite-plugin-contribution",
  }
  const registryFile = join(root, eager ? "durability-registry.mjs" : "registry.mjs")
  await writeFile(registryFile, createWorkspaceRegistryContents(registryFile, [definition], undefined, eager))
  const { default: registry } = await import(pathToFileURL(registryFile).href)
  return registry
}

const expected = {
  code: "WORKSPACE_REGISTRY_LOAD_FAILED",
  docs: "https://vitehub.dev/docs/workspace/diagnostics/workspace_registry_load_failed",
  fix: expect.stringContaining("Read `error.cause` for the first error."),
  message: expect.stringMatching(/^The module of Workspace "content" did not load: \[vitehub\] Workspace "content" module .* has no export "contentWorkspace"\./),
  cause: expect.any(TypeError),
}

it("gives a failure of the generated registry its code and fix when the app loads the Workspace", async () => {
  setWorkspaceRegistry(await writeRegistry(false) as WorkspaceRegistry)

  await expect(resolveRegisteredWorkspaceDefinition("content")).rejects.toMatchObject(expected)
})

it("gives a failure of the eager generated registry its code and fix in the durability report", async () => {
  const registry = await writeRegistry(true)

  expect(() => workspaceRegistryDefinitions(registry)).toThrow(expect.objectContaining(expected))
})

it("keeps a coded error of the Definition module unchanged", async () => {
  const coded = workspaceErrorDiagnostics.WORKSPACE_R0016({ message: "[vitehub] defineWorkspace() expects an object." })
  setWorkspaceRegistry({ content: async () => { throw coded } })

  await expect(resolveRegisteredWorkspaceDefinition("content")).rejects.toBe(coded)
})

it("keeps a coded error from another copy of Nostics unchanged", async () => {
  // A Definition module can throw the diagnostic of another package, which may bundle its own copy of Nostics.
  const coded = Object.assign(new Error("The Agent is busy."), { code: "AGENT_BUSY", name: "AGENT_BUSY", why: "The Agent is busy.", toJSON: () => ({}) })
  expect(coded).not.toBeInstanceOf(Diagnostic)
  setWorkspaceRegistry({ content: async () => { throw coded } })

  await expect(resolveRegisteredWorkspaceDefinition("content")).rejects.toBe(coded)
})
