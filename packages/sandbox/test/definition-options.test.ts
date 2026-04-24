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
  it("reads options from a direct default defineSandbox export", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vitehub/sandbox"`,
      ``,
      `export default defineSandbox(async () => null, { timeout: 1000 })`,
      ``,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).resolves.toEqual({ timeout: 1000 })
  })

  it("reads options when defineSandbox is exported through a local binding", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vitehub/sandbox"`,
      ``,
      `const releaseNotes = defineSandbox(async () => null, {`,
      `  env: { MODE: "test" },`,
      `  timeout: 2000,`,
      `})`,
      ``,
      `export default releaseNotes`,
      ``,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).resolves.toEqual({
      env: { MODE: "test" },
      timeout: 2000,
    })
  })
})
