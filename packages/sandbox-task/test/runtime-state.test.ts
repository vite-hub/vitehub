import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it, vi } from "vitest"

import {
  createGeneratedSandboxTaskModuleSpecifier,
  createGeneratedSandboxTaskRuntimeRegistry,
  resetSandboxTaskRuntimeState,
  setSandboxTaskRuntimeRegistry,
} from "../src/runtime/state.ts"

const tempDirs: string[] = []

afterEach(async () => {
  resetSandboxTaskRuntimeState()
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it("keeps the activated registry when a retained generation evaluates later", async () => {
  const scope = join(tmpdir(), "vitehub-sandbox-task-active-runtime", "sandbox-task.mjs")
  const loadRetained = vi.fn(async () => ({ default: { bundle: { entry: "retained.mjs", modules: {} } } }))
  const loadCurrent = vi.fn(async () => ({ default: { bundle: { entry: "current.mjs", modules: {} } } }))
  const currentRegistry = createGeneratedSandboxTaskRuntimeRegistry(scope, {
    example: { load: loadCurrent, stablePath: "current.mjs" },
  })
  setSandboxTaskRuntimeRegistry(currentRegistry)

  createGeneratedSandboxTaskRuntimeRegistry(scope, {
    example: { load: loadRetained, stablePath: "retained.mjs" },
  })

  const loadCurrentDefinition = currentRegistry.example
  if (typeof loadCurrentDefinition !== "function")
    throw new TypeError("Expected a generated Sandbox Task Definition loader.")
  await expect(loadCurrentDefinition()).resolves.toMatchObject({ default: { bundle: { entry: "current.mjs" } } })
  expect(loadCurrent).toHaveBeenCalledOnce()
  expect(loadRetained).not.toHaveBeenCalled()
})

it("does not load a removed definition through a retained registry", async () => {
  const scope = join(tmpdir(), "vitehub-sandbox-task-removed-runtime", "sandbox-task.mjs")
  const loadRetained = vi.fn(async () => ({ default: { bundle: { entry: "retained.mjs", modules: {} } } }))
  const retainedRegistry = createGeneratedSandboxTaskRuntimeRegistry(scope, {
    removed: { load: loadRetained, stablePath: "retained.mjs" },
  })
  const activeRegistry = createGeneratedSandboxTaskRuntimeRegistry(scope, {})
  setSandboxTaskRuntimeRegistry(activeRegistry)

  const loadRemovedDefinition = retainedRegistry.removed
  if (typeof loadRemovedDefinition !== "function")
    throw new TypeError("Expected a retained Sandbox Task Definition loader.")
  await expect(loadRemovedDefinition()).rejects.toThrow('Sandbox Task Definition "removed" is no longer generated')
  expect(loadRetained).not.toHaveBeenCalled()
})

it("resolves the active Windows generation when a retained registry generation was pruned", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-task-runtime-state-"))
  tempDirs.push(root)
  const runtimeDir = join(root, "runtime")
  const generationsDir = join(root, ".runtime-generations")
  const retainedDefinition = join(generationsDir, "runtime-retained", "definition.mjs")
  const currentDefinition = join(generationsDir, "runtime-current", "definition.mjs")
  const nextDefinition = join(generationsDir, "runtime-next", "definition.mjs")
  const activeFacade = join(runtimeDir, "sandbox-task.mjs")
  const missingStableDefinition = join(runtimeDir, "sandbox-task-definitions", "example.mjs")
  await mkdir(join(generationsDir, "runtime-retained"), { recursive: true })
  await mkdir(join(generationsDir, "runtime-current"), { recursive: true })
  await mkdir(join(generationsDir, "runtime-next"), { recursive: true })
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(retainedDefinition, `export default { bundle: { value: "retained" } }\n`)
  await writeFile(currentDefinition, `export default { bundle: { value: "current" } }\n`)
  await writeFile(nextDefinition, `export default { bundle: { value: "next" } }\n`)

  const registry = createGeneratedSandboxTaskRuntimeRegistry(activeFacade.replaceAll("/", "\\"), {
    example: {
      load: async () => await import(pathToFileURL(retainedDefinition).href),
      stablePath: missingStableDefinition.replaceAll("/", "\\"),
    },
  })
  setSandboxTaskRuntimeRegistry(registry)
  const loadRetainedDefinition = registry.example
  if (typeof loadRetainedDefinition !== "function")
    throw new TypeError("Expected a generated Sandbox Task Definition loader.")

  await rm(join(generationsDir, "runtime-retained"), { recursive: true })
  await writeFile(activeFacade, `export default { example: async () => import(${JSON.stringify(pathToFileURL(currentDefinition).href)}) }\n`)
  await expect(loadRetainedDefinition()).resolves.toMatchObject({ default: { bundle: { value: "current" } } })

  await rm(join(generationsDir, "runtime-current"), { recursive: true })
  await writeFile(activeFacade, `export default { example: async () => import(${JSON.stringify(pathToFileURL(nextDefinition).href)}) }\n`)
  await expect(loadRetainedDefinition()).resolves.toMatchObject({ default: { bundle: { value: "next" } } })
})

it("reloads a replaced stable Definition during Windows recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-task-stable-recovery-"))
  tempDirs.push(root)
  const missingDefinition = join(root, ".runtime-generations", "runtime-pruned", "definition.mjs")
  const stableDefinition = join(root, "runtime", "sandbox-task-definitions", "example.mjs")
  await mkdir(join(root, "runtime", "sandbox-task-definitions"), { recursive: true })
  await writeFile(stableDefinition, `export default { bundle: { value: "current" } }\n`)

  const registry = createGeneratedSandboxTaskRuntimeRegistry(join(root, "runtime", "sandbox-task.mjs"), {
    example: {
      load: async () => await import(pathToFileURL(missingDefinition).href),
      stablePath: stableDefinition,
    },
  })
  setSandboxTaskRuntimeRegistry(registry)
  const loadDefinition = registry.example
  if (typeof loadDefinition !== "function")
    throw new TypeError("Expected a generated Sandbox Task Definition loader.")

  await expect(loadDefinition()).resolves.toMatchObject({ default: { bundle: { value: "current" } } })
  await writeFile(stableDefinition, `export default { bundle: { value: "next" } }\n`)
  await expect(loadDefinition()).resolves.toMatchObject({ default: { bundle: { value: "next" } } })
})

it("encodes URL-significant filesystem characters in recovery specifiers", () => {
  const path = join(tmpdir(), "vitehub-sandbox-task-#%-runtime", "sandbox-task.mjs")
  const specifier = createGeneratedSandboxTaskModuleSpecifier(path, true)

  expect(specifier).toContain("vitehub-sandbox-task-%23%25-runtime")
  expect(new URL(specifier).searchParams.has("vitehub-recovery")).toBe(true)
})
