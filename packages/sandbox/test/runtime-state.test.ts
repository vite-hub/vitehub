import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it, vi } from "vitest"

import {
  createGeneratedSandboxModuleSpecifier,
  createGeneratedSandboxRuntimeRegistry,
  resetSandboxRuntimeState,
  setSandboxRuntimeRegistry,
} from "../src/runtime/state.ts"

const tempDirs: string[] = []

afterEach(async () => {
  resetSandboxRuntimeState()
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it("keeps the activated registry when a retained generation evaluates later", async () => {
  const scope = join(tmpdir(), "vitehub-sandbox-active-runtime", "sandbox.mjs")
  const loadRetained = vi.fn(async () => ({ default: { bundle: { entry: "retained.mjs", modules: {} } } }))
  const loadCurrent = vi.fn(async () => ({ default: { bundle: { entry: "current.mjs", modules: {} } } }))
  const currentRegistry = createGeneratedSandboxRuntimeRegistry(scope, {
    example: { load: loadCurrent, stablePath: "current.mjs" },
  })
  setSandboxRuntimeRegistry(currentRegistry)

  createGeneratedSandboxRuntimeRegistry(scope, {
    example: { load: loadRetained, stablePath: "retained.mjs" },
  })

  const loadCurrentDefinition = currentRegistry.example
  if (typeof loadCurrentDefinition !== "function")
    throw new TypeError("Expected a generated Sandbox Definition loader.")
  await expect(loadCurrentDefinition()).resolves.toMatchObject({ default: { bundle: { entry: "current.mjs" } } })
  expect(loadCurrent).toHaveBeenCalledOnce()
  expect(loadRetained).not.toHaveBeenCalled()
})

it("does not load a removed definition through a retained registry", async () => {
  const scope = join(tmpdir(), "vitehub-sandbox-removed-runtime", "sandbox.mjs")
  const loadRetained = vi.fn(async () => ({ default: { bundle: { entry: "retained.mjs", modules: {} } } }))
  const retainedRegistry = createGeneratedSandboxRuntimeRegistry(scope, {
    removed: { load: loadRetained, stablePath: "retained.mjs" },
  })
  const activeRegistry = createGeneratedSandboxRuntimeRegistry(scope, {})
  setSandboxRuntimeRegistry(activeRegistry)

  const loadRemovedDefinition = retainedRegistry.removed
  if (typeof loadRemovedDefinition !== "function")
    throw new TypeError("Expected a retained Sandbox Definition loader.")
  await expect(loadRemovedDefinition()).rejects.toThrow('Sandbox definition "removed" is no longer generated')
  expect(loadRetained).not.toHaveBeenCalled()
})

it("resolves the active Windows generation when a retained registry generation was pruned", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-runtime-state-"))
  tempDirs.push(root)
  const runtimeDir = join(root, "runtime")
  const generationsDir = join(root, ".runtime-generations")
  const retainedDefinition = join(generationsDir, "runtime-retained", "definition.mjs")
  const currentDefinition = join(generationsDir, "runtime-current", "definition.mjs")
  const nextDefinition = join(generationsDir, "runtime-next", "definition.mjs")
  const activeFacade = join(runtimeDir, "sandbox.mjs")
  const missingStableDefinition = join(runtimeDir, "sandbox-definitions", "example.mjs")
  await mkdir(join(generationsDir, "runtime-retained"), { recursive: true })
  await mkdir(join(generationsDir, "runtime-current"), { recursive: true })
  await mkdir(join(generationsDir, "runtime-next"), { recursive: true })
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(retainedDefinition, `export default { bundle: { value: "retained" } }\n`)
  await writeFile(currentDefinition, `export default { bundle: { value: "current" } }\n`)
  await writeFile(nextDefinition, `export default { bundle: { value: "next" } }\n`)

  const registry = createGeneratedSandboxRuntimeRegistry(activeFacade.replaceAll("/", "\\"), {
    example: {
      load: async () => await import(pathToFileURL(retainedDefinition).href),
      stablePath: missingStableDefinition.replaceAll("/", "\\"),
    },
  })
  setSandboxRuntimeRegistry(registry)
  const loadRetainedDefinition = registry.example
  if (typeof loadRetainedDefinition !== "function")
    throw new TypeError("Expected a generated Sandbox Definition loader.")

  await rm(join(generationsDir, "runtime-retained"), { recursive: true })
  await writeFile(activeFacade, `export default { example: async () => import(${JSON.stringify(pathToFileURL(currentDefinition).href)}) }\n`)
  await expect(loadRetainedDefinition()).resolves.toMatchObject({ default: { bundle: { value: "current" } } })

  await rm(join(generationsDir, "runtime-current"), { recursive: true })
  await writeFile(activeFacade, `export default { example: async () => import(${JSON.stringify(pathToFileURL(nextDefinition).href)}) }\n`)
  await expect(loadRetainedDefinition()).resolves.toMatchObject({ default: { bundle: { value: "next" } } })
})

it("encodes URL-significant filesystem characters in recovery specifiers", () => {
  const path = join(tmpdir(), "vitehub-sandbox-#%-runtime", "sandbox.mjs")
  const specifier = createGeneratedSandboxModuleSpecifier(path, true)

  expect(specifier).toContain("vitehub-sandbox-%23%25-runtime")
  expect(new URL(specifier).searchParams.has("vitehub-recovery")).toBe(true)
})
