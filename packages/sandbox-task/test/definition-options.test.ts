import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { extractSandboxTaskDefinitionMetadata } from "../src/definition-options.ts"

const tempDirs: string[] = []

async function writeDefinition(source: string) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-sandbox-task-options-"))
  tempDirs.push(rootDir)
  const file = join(rootDir, "definition.sandbox-task.ts")
  await writeFile(file, source)
  return file
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe("extractSandboxTaskDefinitionMetadata", () => {
  it("reads portable options from an object-form Definition", async () => {
    const file = await writeDefinition([
      `import { defineSandboxTask } from "@vite-hub/sandbox-task"`,
      `export default defineSandboxTask({`,
      `  env: { MODE: "test" },`,
      `  timeout: 30_000,`,
      `  async run() { return null },`,
      `})`,
    ].join("\n"))

    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({
      options: {
        env: { MODE: "test" },
        timeout: 30_000,
      },
    })
  })

  it("preserves a static __proto__ environment key", async () => {
    const file = await writeDefinition([
      `import { defineSandboxTask } from "@vite-hub/sandbox-task"`,
      `export default defineSandboxTask({`,
      `  env: { "__proto__": "sandbox-value" },`,
      `  run: async () => null,`,
      `})`,
    ].join("\n"))

    const metadata = await extractSandboxTaskDefinitionMetadata(file)
    expect(metadata?.options?.env).toHaveProperty("__proto__", "sandbox-value")
    expect(Object.hasOwn(metadata?.options?.env || {}, "__proto__")).toBe(true)
  })

  it("preserves a static top-level __proto__ option key", async () => {
    const file = await writeDefinition([
      `import { defineSandboxTask } from "@vite-hub/sandbox-task"`,
      `export default defineSandboxTask({`,
      `  "__proto__": { enabled: true },`,
      `  run: async () => null,`,
      `})`,
    ].join("\n"))

    const metadata = await extractSandboxTaskDefinitionMetadata(file)
    expect(metadata?.options).toHaveProperty("__proto__", { enabled: true })
    expect(Object.hasOwn(metadata?.options || {}, "__proto__")).toBe(true)
  })

  it("separates the compiler project policy from runtime options", async () => {
    const file = await writeDefinition([
      `import { defineSandboxTask } from "@vite-hub/sandbox-task"`,
      `export default defineSandboxTask({ project: false, run: async () => null, timeout: 1000 })`,
    ].join("\n"))

    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({
      options: { timeout: 1000 },
      project: false,
    })
  })

  it("reads project policy through an aliased factory import", async () => {
    const file = await writeDefinition([
      `import { defineSandboxTask as sandbox } from "@vite-hub/sandbox-task"`,
      `export default sandbox({ project: false, run: async () => null })`,
    ].join("\n"))

    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({ project: false })
  })

  it("reads project policy through a namespace factory import", async () => {
    const file = await writeDefinition([
      `import * as sandbox from "@vite-hub/sandbox-task"`,
      `export default sandbox.defineSandboxTask({ project: true, run: async () => null })`,
    ].join("\n"))

    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({ project: true })
  })

  it("supports a property-assigned run handler", async () => {
    const file = await writeDefinition([
      `import { defineSandboxTask } from "@vite-hub/sandbox-task"`,
      `export default defineSandboxTask({ run: async () => null, timeout: 1000 })`,
    ].join("\n"))

    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({ options: { timeout: 1000 } })
  })

  it("supports a shorthand run handler", async () => {
    const file = await writeDefinition(`const run = async () => null\nexport default defineSandboxTask({ run, timeout: 1000 })`)
    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({ options: { timeout: 1000 } })
  })

  it("requires one direct object literal", async () => {
    const file = await writeDefinition([
      `import { defineSandboxTask } from "@vite-hub/sandbox-task"`,
      `export default defineSandboxTask(async () => null)`,
    ].join("\n"))

    await expect(extractSandboxTaskDefinitionMetadata(file)).rejects.toThrow("one direct object literal")
  })

  it("requires a run handler", async () => {
    const file = await writeDefinition(`export default defineSandboxTask({ timeout: 1000 })`)
    await expect(extractSandboxTaskDefinitionMetadata(file)).rejects.toThrow("requires a `run` handler")
  })

  it("rejects computed options", async () => {
    const file = await writeDefinition(
      `export default defineSandboxTask({ run: async () => null, timeout: 1000 * 2 })`,
    )
    await expect(extractSandboxTaskDefinitionMetadata(file)).rejects.toThrow("static JSON-serializable values")
  })

  it("requires a static boolean project policy", async () => {
    const file = await writeDefinition(
      `export default defineSandboxTask({ project: "auto", run: async () => null })`,
    )
    await expect(extractSandboxTaskDefinitionMetadata(file)).rejects.toThrow("project must be a boolean")
  })

  it("reads project policy through an exported immutable Definition binding", async () => {
    const file = await writeDefinition([
      `const definition = defineSandboxTask({ project: false, run: async () => null, timeout: 1000 })`,
      `export default definition`,
    ].join("\n"))
    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({
      options: { timeout: 1000 },
      project: false,
    })
  })

  it("reads project policy through a named default export", async () => {
    const file = await writeDefinition([
      `const definition = defineSandboxTask({ project: true, run: async () => null, timeout: 1000 })`,
      `export { definition as default }`,
    ].join("\n"))
    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({
      options: { timeout: 1000 },
      project: true,
    })
  })

  it("reads project policy through a parenthesized Definition export", async () => {
    const file = await writeDefinition(
      `export default (defineSandboxTask({ project: true, run: async () => null }))`,
    )
    await expect(extractSandboxTaskDefinitionMetadata(file)).resolves.toEqual({ project: true })
  })
})
