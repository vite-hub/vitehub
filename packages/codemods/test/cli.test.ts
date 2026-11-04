import { execFile } from "node:child_process"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterAll, describe, expect, it } from "vitest"

import { codemods, runCli } from "../src/index.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtures = join(packageRoot, "test/fixtures")
const scratch = join(packageRoot, ".tmp/cli-test")
const execute = promisify(execFile)

async function cli(args: string[]) {
  let stdout = ""
  let stderr = ""
  const code = await runCli(args, { stdout: text => stdout += text, stderr: text => stderr += text })
  return { code, stdout, stderr }
}

async function app(name: string, files: Record<string, string>): Promise<string> {
  const directory = join(scratch, name)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  for (const [path, content] of Object.entries(files)) await writeFile(join(directory, path), content)
  return directory
}

afterAll(() => rm(scratch, { recursive: true, force: true }))

describe("codemods CLI", () => {
  it("lists every codemod with one line when it has no arguments or --help", async () => {
    for (const args of [[], ["--help"]]) {
      const result = await cli(args)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Usage: npx @vite-hub/codemods <codemod> [dir] [--dry-run]")
      for (const codemod of codemods) expect(result.stdout).toContain(`  ${codemod.name}  ${codemod.description}\n`)
    }
  })

  it("rejects an unknown codemod or option", async () => {
    expect(await cli(["nope"])).toMatchObject({ code: 1, stderr: expect.stringContaining("Unknown codemod \"nope\". Available: nuxt-safe-runtime-config.") })
    expect(await cli(["nuxt-safe-runtime-config", "--force"])).toMatchObject({ code: 1, stderr: expect.stringContaining("Unknown option --force.") })
  })

  it("writes nothing in a dry run and prints the diff and the report", async () => {
    const input = join(fixtures, "env-schema/input")
    const before = await readFile(join(input, "nuxt.config.ts"), "utf8")
    const result = await cli(["nuxt-safe-runtime-config", input, "--dry-run"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("--- a/nuxt.config.ts\n+++ b/nuxt.config.ts")
    expect(result.stdout).toContain("Dry run: no files were written.")
    expect(await readFile(join(input, "nuxt.config.ts"), "utf8")).toBe(before)
  })

  it("writes the planned files", async () => {
    const directory = join(scratch, "write")
    await rm(directory, { recursive: true, force: true })
    await cp(join(fixtures, "env-schema/input"), directory, { recursive: true })
    const result = await cli(["nuxt-safe-runtime-config", directory])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Files changed (5):")
    expect(await readFile(join(directory, "nuxt.config.ts"), "utf8")).toBe(await readFile(join(fixtures, "env-schema/output/nuxt.config.ts"), "utf8"))
    expect(await readFile(join(directory, "server/api/limits.get.ts"), "utf8")).toBe(await readFile(join(fixtures, "env-schema/output/server/api/limits.get.ts"), "utf8"))
  })

  it("runs as the package binary", async () => {
    const { stdout } = await execute(process.execPath, [join(packageRoot, "dist/cli.js"), "--help"])
    expect(stdout).toContain("Usage: npx @vite-hub/codemods")
    expect(stdout).toContain("nuxt-safe-runtime-config")
    const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
    expect(manifest).toMatchObject({ bin: { "vitehub-codemods": "./dist/cli.js" } })
  })
})

describe("nuxt-safe-runtime-config errors", () => {
  it.each([
    ["no nuxt.config", {}, "Cannot find nuxt.config in"],
    ["a nuxt.config that does not parse", { "nuxt.config.ts": "export default defineNuxtConfig({" }, "Cannot parse nuxt.config.ts"],
    ["a config that is not an object literal", { "nuxt.config.ts": "export default createConfig()" }, "must export an object literal"],
    ["no module", { "nuxt.config.ts": "export default defineNuxtConfig({ modules: [] })" }, "does not use nuxt-safe-runtime-config"],
    ["no schema", { "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'] })" }, "has no envSchema and no $schema"],
    ["both schema sources", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { envSchema: '.env.example', $schema: './schema' } })",
    }, "sets both envSchema and $schema"],
    ["a missing envSchema file", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { envSchema: '.env.example' } })",
    }, "Cannot find the envSchema file .env.example"],
    ["a non-standard schema", {
      "nuxt.config.ts": "export default defineNuxtConfig({ modules: ['nuxt-safe-runtime-config'], safeRuntimeConfig: { $schema: { type: 'object' } } })",
    }, "The $schema is not a Standard Schema"],
  ])("exits with 1 for %s", async (name, files, message) => {
    const directory = await app(name.replaceAll(" ", "-"), files)
    const result = await cli(["nuxt-safe-runtime-config", directory])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(message)
  })
})
