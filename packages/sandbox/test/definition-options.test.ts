import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { extractSandboxDefinitionOptions } from "../src/definition-options.ts"

const tempDirs: string[] = []

async function writeDefinition(source: string) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-sandbox-options-"))
  tempDirs.push(rootDir)
  const file = join(rootDir, "definition.sandbox.ts")
  await writeFile(file, source)
  return file
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe("extractSandboxDefinitionOptions", () => {
  it("reads portable options from an object-form Definition", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      `export default defineSandbox({`,
      `  env: { MODE: "test" },`,
      `  timeout: 30_000,`,
      `  async run() { return null },`,
      `})`,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).resolves.toEqual({
      env: { MODE: "test" },
      timeout: 30_000,
    })
  })

  it("supports a property-assigned run handler", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      `export default defineSandbox({ run: async () => null, timeout: 1000 })`,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).resolves.toEqual({ timeout: 1000 })
  })

  it("supports a shorthand run handler", async () => {
    const file = await writeDefinition(`const run = async () => null\nexport default defineSandbox({ run, timeout: 1000 })`)
    await expect(extractSandboxDefinitionOptions(file)).resolves.toEqual({ timeout: 1000 })
  })

  it("requires one direct object literal", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      `export default defineSandbox(async () => null)`,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).rejects.toThrow("one direct object literal")
  })

  it("requires a run handler", async () => {
    const file = await writeDefinition(`export default defineSandbox({ timeout: 1000 })`)
    await expect(extractSandboxDefinitionOptions(file)).rejects.toThrow("requires a `run` handler")
  })

  it("rejects computed options", async () => {
    const file = await writeDefinition(
      `export default defineSandbox({ run: async () => null, timeout: 1000 * 2 })`,
    )
    await expect(extractSandboxDefinitionOptions(file)).rejects.toThrow("static JSON-serializable values")
  })

  it("ignores local bindings because build options must be inspectable", async () => {
    const file = await writeDefinition([
      `const definition = defineSandbox({ run: async () => null, timeout: 1000 })`,
      `export default definition`,
    ].join("\n"))
    await expect(extractSandboxDefinitionOptions(file)).resolves.toBeUndefined()
  })
})
