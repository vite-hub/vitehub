import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  extractCloudflareDockerfileFragment,
  extractSandboxDefinitionOptions,
  stripCloudflareDockerfileFragment,
} from "../src/definition-options.ts"

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
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      ``,
      `export default defineSandbox(async () => null, { timeout: 1000 })`,
      ``,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).resolves.toEqual({ timeout: 1000 })
  })

  it("ignores options when defineSandbox is exported through a local binding", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      ``,
      `const releaseNotes = defineSandbox(async () => null, {`,
      `  env: { MODE: "test" },`,
      `  timeout: 2000,`,
      `})`,
      ``,
      `export default releaseNotes`,
      ``,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).resolves.toBeUndefined()
  })

  it("rejects arithmetic and string concatenation in extracted options", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      ``,
      `export default defineSandbox(async () => null, {`,
      `  env: { MODE: "te" + "st" },`,
      `  timeout: 1000 * 2,`,
      `})`,
      ``,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).rejects.toThrow("static JSON-serializable values")
  })

  it("reads nested JSON-like literal option values", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      ``,
      `export default defineSandbox(async () => null, {`,
      `  env: { MODE: "test" },`,
      `  runtime: { command: "node", args: ["worker.mjs"] },`,
      `  timeout: 30_000,`,
      `})`,
      ``,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).resolves.toEqual({
      env: { MODE: "test" },
      runtime: { command: "node", args: ["worker.mjs"] },
      timeout: 30000,
    })
  })

  it("preserves parenthesized static literal option values", async () => {
    const file = await writeDefinition([
      `import { defineSandbox } from "@vite-hub/sandbox"`,
      ``,
      `export default defineSandbox(async () => null, {`,
      `  env: { MODE: ("test") },`,
      `  runtime: { command: ("node"), args: [("worker.mjs")] },`,
      `  timeout: (30_000),`,
      `})`,
      ``,
    ].join("\n"))

    await expect(extractSandboxDefinitionOptions(file)).resolves.toEqual({
      env: { MODE: "test" },
      runtime: { command: "node", args: ["worker.mjs"] },
      timeout: 30000,
    })
  })
})

describe("Cloudflare Dockerfile fragment extraction", () => {
  it("preserves raw template text and strips build-only source", async () => {
    const file = await writeDefinition([
      `import { defineDockerfileFragment } from "vite-hub/sandbox/cloudflare"`,
      `import { defineSandbox } from "vite-hub/sandbox"`,
      ``,
      `defineDockerfileFragment\``,
      `RUN apt-get update \\`,
      `  && apt-get install -y imagemagick`,
      `\``,
      ``,
      `export default defineSandbox(async () => null)`,
      ``,
    ].join("\n"))

    const fragment = await extractCloudflareDockerfileFragment(file)
    expect(fragment).toBe("\nRUN apt-get update \\\n  && apt-get install -y imagemagick\n")

    const source = await readFile(file, "utf8")
    const stripped = stripCloudflareDockerfileFragment(source, file)
    expect(stripped).not.toContain("defineDockerfileFragment")
    expect(stripped).not.toContain("imagemagick")
    expect(stripped).toContain("export default defineSandbox")
  })

  it("rejects interpolated fragments", async () => {
    const file = await writeDefinition([
      `import { defineDockerfileFragment } from "vite-hub/sandbox/cloudflare"`,
      `const packageName = "imagemagick"`,
      'defineDockerfileFragment`RUN apt-get install ${packageName}`',
    ].join("\n"))

    await expect(extractCloudflareDockerfileFragment(file)).rejects.toThrow("without interpolations")
  })

  it("rejects the former exported fragment shape", async () => {
    const file = await writeDefinition([
      `import { defineDockerfileFragment } from "vite-hub/sandbox/cloudflare"`,
      `export const cloudflareDockerfileFragment = defineDockerfileFragment\`RUN true\``,
    ].join("\n"))

    await expect(extractCloudflareDockerfileFragment(file)).rejects.toThrow("top-level")
  })

  it("rejects interpolated fragments assigned to a variable", async () => {
    const file = await writeDefinition([
      `import { defineDockerfileFragment } from "vite-hub/sandbox/cloudflare"`,
      `const packageName = "imagemagick"`,
      'const fragment = defineDockerfileFragment`RUN apt-get install ${packageName}`',
    ].join("\n"))

    await expect(extractCloudflareDockerfileFragment(file)).rejects.toThrow("top-level")
  })

  it("rejects FROM instructions", async () => {
    const file = await writeDefinition([
      `import { defineDockerfileFragment } from "vite-hub/sandbox/cloudflare"`,
      `defineDockerfileFragment\`FROM alpine\``,
    ].join("\n"))

    await expect(extractCloudflareDockerfileFragment(file)).rejects.toThrow("cannot contain FROM")
  })

  it("ignores a local helper with the same name", async () => {
    const file = await writeDefinition([
      `const defineDockerfileFragment = String.raw`,
      `defineDockerfileFragment\`RUN true\``,
    ].join("\n"))

    await expect(extractCloudflareDockerfileFragment(file)).resolves.toBeUndefined()
  })

  it("rejects namespace imports from the fragment marker module", async () => {
    const file = await writeDefinition([
      `import * as cloudflare from "vite-hub/sandbox/cloudflare"`,
      `cloudflare.defineDockerfileFragment\`RUN true\``,
    ].join("\n"))

    await expect(extractCloudflareDockerfileFragment(file)).rejects.toThrow("named import")
  })
})
