import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { resolveDBViteConfig } from "../src/config.ts"
import { writeGeneratedDatabaseArtifacts } from "../src/internal/generated.ts"

const execFileAsync = promisify(execFile)
const drizzleKitBin = join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.cjs")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createProject() {
  const rootDir = await mkdtemp(join(import.meta.dirname, ".generated-"))
  tempDirs.push(rootDir)
  await mkdir(join(rootDir, "server/databases"), { recursive: true })
  await writeFile(join(rootDir, "package.json"), '{ "type": "module" }\n')
  return rootDir
}

async function writeDefinition(rootDir: string, options: string) {
  await writeFile(join(rootDir, "server/databases/config.ts"), [
    "import { defineDatabase } from '@vite-hub/database'",
    "import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'",
    "const users = sqliteTable('users', { id: integer().primaryKey(), displayName: text() })",
    "const schema = { users }",
    "const drizzle = { casing: 'snake_case' as const }",
    `export default defineDatabase({ ${options} })`,
  ].join("\n"))
  const config = resolveDBViteConfig(undefined, rootDir)!
  await writeGeneratedDatabaseArtifacts(config)
  return config
}

async function runKit(rootDir: string, configFile: string, command = "generate", nodeArgs: string[] = [], env?: NodeJS.ProcessEnv) {
  const result = await execFileAsync(process.execPath, [...nodeArgs, drizzleKitBin, command, "--config", configFile], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    timeout: 15_000,
  })
  // Kit can report schema import errors and still exit successfully.
  expect(result.stderr).toBe("")
  return result.stdout
}

describe("generated Drizzle Kit credentials", { timeout: 45_000 }, () => {
  it.each(["process.env.VITEHUB_TEST_DATABASE_URL", "'libsql://test.invalid'"])("forwards runtime auth tokens to the real Kit libSQL connection with URL %s", async (url) => {
    const rootDir = await createProject()
    const config = await writeDefinition(rootDir, [
      "schema: { users },",
      `connection: { url: ${url}, authToken: process.env.VITEHUB_TEST_DATABASE_TOKEN },`,
    ].join("\n"))
    const captureFile = join(rootDir, "client.json")
    const hookFile = join(rootDir, "capture-client.mjs")
    await writeFile(hookFile, [
      "import { registerHooks } from 'node:module'",
      "registerHooks({",
      "  resolve(specifier, context, nextResolve) {",
      "    if (specifier !== '@libsql/client') return nextResolve(specifier, context)",
      "    return { url: 'test:libsql-client', shortCircuit: true }",
      "  },",
      "  load(url, context, nextLoad) {",
      "    if (url !== 'test:libsql-client') return nextLoad(url, context)",
      `    return { format: 'module', shortCircuit: true, source: ${JSON.stringify([
        "import { writeFileSync } from 'node:fs'",
        "export function createClient(options) {",
        `  writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(options))`,
        "  process.exit(0)",
        "}",
      ].join("\n"))} }`,
      "  },",
      "})",
    ].join("\n"))

    await runKit(rootDir, config.generatedDrizzleConfigFile, "migrate", ["--import", hookFile], {
      VITEHUB_TEST_DATABASE_URL: "libsql://test.invalid",
      VITEHUB_TEST_DATABASE_TOKEN: "test-token",
    })
    expect(JSON.parse(await readFile(captureFile, "utf8"))).toEqual({
      url: "libsql://test.invalid",
      authToken: "test-token",
    })
    const generatedConfig = await readFile(config.generatedDrizzleConfigFile, "utf8")
    expect(generatedConfig).not.toContain("test-token")
    if (url.startsWith("process.env")) expect(generatedConfig).not.toContain("libsql://test.invalid")

    await runKit(rootDir, config.generatedDrizzleConfigFile, "migrate", ["--import", hookFile], {
      VITEHUB_TEST_DATABASE_URL: "libsql://rotated.invalid",
      VITEHUB_TEST_DATABASE_TOKEN: "rotated-token",
    })
    expect(JSON.parse(await readFile(captureFile, "utf8"))).toEqual({
      url: url.startsWith("process.env") ? "libsql://rotated.invalid" : "libsql://test.invalid",
      authToken: "rotated-token",
    })

    await runKit(rootDir, config.generatedDrizzleConfigFile, "migrate", ["--import", hookFile], {
      VITEHUB_TEST_DATABASE_URL: "libsql://test.invalid",
      VITEHUB_TEST_DATABASE_TOKEN: "",
    })
    expect(JSON.parse(await readFile(captureFile, "utf8"))).toEqual({ url: "libsql://test.invalid" })
  })

  it.each([
    ["file:test.db", "", "sqlite"],
    ["libsql://test.invalid", "", "turso"],
    ["https://test.invalid", "test-token", "turso"],
  ])("selects the Kit dialect for %s at invocation time", async (url, authToken, dialect) => {
    const rootDir = await createProject()
    const config = await writeDefinition(rootDir, "schema, connection: { url: process.env.VITEHUB_TEST_DATABASE_URL, authToken: process.env.VITEHUB_TEST_DATABASE_TOKEN }")
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", [
      `import config from ${JSON.stringify(pathToFileURL(config.generatedDrizzleConfigFile).href)}`,
      "console.log(JSON.stringify(config))",
    ].join("\n")], { cwd: rootDir, env: { ...process.env, VITEHUB_TEST_DATABASE_URL: url, VITEHUB_TEST_DATABASE_TOKEN: authToken } })
    const generated = JSON.parse(stdout)
    expect(generated.dialect).toBe(dialect)
    expect(generated.dbCredentials).toEqual(authToken ? { url, authToken } : { url })
  })
})
