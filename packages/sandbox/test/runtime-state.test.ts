import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, expect, it } from "vitest"

import { createGeneratedSandboxRuntimeRegistry } from "../src/runtime/state.ts"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(root => rm(root, { recursive: true, force: true })))
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
