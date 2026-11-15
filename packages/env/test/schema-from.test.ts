import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createProgram, flattenDiagnosticMessageText, getPreEmitDiagnostics, ModuleKind, ModuleResolutionKind, ScriptTarget } from "typescript"
import { build } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry, resolveEnvEntries, createSourceContext } from "../src/core/resolve.ts"
import { hubEnv } from "../src/vite.ts"

const execute = promisify(execFile)
// Inside the package, so the build resolves zod and @vite-hub/env like an installed app.
const temporaryRoot = fileURLToPath(new URL("../.vitest-tmp/", import.meta.url))
const syntheticToken = "schema-from-synthetic-token-0123456789"
const shortToken = "short-secret-value"

let root: string

const schemaModule = `import { z } from "zod"

export const apiUrl = z.url().refine(value => value.startsWith("https://"), "Use an https URL.")
export const retries = z.coerce.number().int().min(1).max(5)
export const tags = z.string().transform(value => value.split(",").map(tag => tag.trim()))
export const token = z.string().min(20)
export const withoutMetadata = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value: String(value).toUpperCase() }),
  },
}
export const notASchema = { parse: () => "nope" }
`

const serverEntry = `import { inspectServerEnv, useServerEnv } from "@vite-hub/env"

const mode = process.argv[2]
if (mode === "inspect") {
  const inspection = await inspectServerEnv()
  console.log(JSON.stringify(inspection.entries.map(entry => [entry.path, entry.status])))
}
else {
  const serverEnv = useServerEnv()
  console.log(JSON.stringify({
    apiUrl: serverEnv.apiUrl,
    retries: serverEnv.retries,
    tags: serverEnv.tags,
    token: String(serverEnv.token),
    tokenLength: serverEnv.token.unseal().length,
    withoutMetadata: serverEnv.withoutMetadata,
  }))
}
`

const consumer = `import { useServerEnv } from "#vitehub/env/server"

const serverEnv = useServerEnv()
export const retries: number = serverEnv.retries
export const tags: string[] = serverEnv.tags
export const token: string = serverEnv.token.unseal()
export const withoutMetadata: unknown = serverEnv.withoutMetadata
// @ts-expect-error A schema without type metadata has an unknown output.
export const wrongWithoutMetadata: string = serverEnv.withoutMetadata
// @ts-expect-error The schema output is a number, not a string.
export const wrong: string = serverEnv.retries
`

async function buildServer(directory: string, server: Record<string, unknown>) {
  await build({
    build: {
      emptyOutDir: true,
      outDir: join(directory, "dist"),
      rollupOptions: { output: { entryFileNames: "server.mjs" } },
      ssr: join(directory, "server.ts"),
    },
    configFile: false,
    logLevel: "silent",
    plugins: [hubEnv({ server: server as never })],
    root: directory,
  })
}

async function runServer(directory: string, values: Record<string, string>, mode?: string) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith("VITEHUB_")) delete environment[key]
  }
  try {
    const result = await execute(process.execPath, [join(directory, "dist", "server.mjs"), ...(mode ? [mode] : [])], {
      cwd: directory,
      env: { ...environment, ...values },
      timeout: 10_000,
    })
    return { code: 0, output: result.stdout + result.stderr }
  }
  catch (error) {
    const failure = error as { code?: number, stdout?: string, stderr?: string }
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` }
  }
}

const validValues = {
  VITEHUB_API_URL: "https://api.example.com",
  VITEHUB_RETRIES: "3",
  VITEHUB_TAGS: "alpha, beta",
  VITEHUB_TOKEN: syntheticToken,
}

beforeAll(async () => {
  await mkdir(temporaryRoot, { recursive: true })
  root = await mkdtemp(join(temporaryRoot, "schema-from-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "schema-from-app", private: true, type: "module" }), "utf8")
  await writeFile(join(root, "env.schema.ts"), schemaModule, "utf8")
  await writeFile(join(root, "server.ts"), serverEntry, "utf8")
  await writeFile(join(root, "consumer.ts"), consumer, "utf8")
  await writeFile(join(root, "root-consumer.ts"), consumer.replace("#vitehub/env/server", "@vite-hub/env"), "utf8")
  await writeFile(join(root, "facade-consumer.ts"), consumer.replace("#vitehub/env/server", "vite-hub/env"), "utf8")
  await buildServer(root, {
    apiUrl: env({ schema: env.schemaFrom("./env.schema.ts", "apiUrl") }),
    retries: env({ default: "2", schema: env.schemaFrom("./env.schema.ts", "retries") }),
    tags: env({ schema: env.schemaFrom("./env.schema.ts", "tags") }),
    token: env({ secret: true, schema: env.schemaFrom("./env.schema.ts", "token") }),
    withoutMetadata: env({ default: "metadata-free", schema: env.schemaFrom("./env.schema.ts", "withoutMetadata") }),
  })
}, 60_000)

afterAll(async () => {
  if (root) await rm(root, { force: true, recursive: true })
})

describe("env.schemaFrom()", () => {
  it("runs the exported schema in the built server, with coercion and transforms", async () => {
    const result = await runServer(root, validValues)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output)).toEqual({
      apiUrl: "https://api.example.com",
      retries: 3,
      tags: ["alpha", "beta"],
      token: "<redacted>",
      tokenLength: syntheticToken.length,
      withoutMetadata: "METADATA-FREE",
    })
  })

  it("checks a default with the schema", async () => {
    const { VITEHUB_RETRIES: _retries, ...values } = validValues
    const result = await runServer(root, values)
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output)).toMatchObject({ retries: 2 })
  })

  it("rejects refinements and constraints that JSON Schema cannot hold", async () => {
    const refinement = await runServer(root, { ...validValues, VITEHUB_API_URL: "http://api.example.com" })
    expect(refinement.code).toBe(1)
    expect(refinement.output).toContain("ENV_RUNTIME_VALUE_INVALID")
    expect(refinement.output).toContain("Use an https URL.")

    const malformed = await runServer(root, { ...validValues, VITEHUB_API_URL: "not a url" })
    expect(malformed.code).toBe(1)
    expect(malformed.output).toContain("env.server.apiUrl")

    const range = await runServer(root, { ...validValues, VITEHUB_RETRIES: "9" })
    expect(range.code).toBe(1)
    expect(range.output).toContain("env.server.retries")

    const integer = await runServer(root, { ...validValues, VITEHUB_RETRIES: "1.5" })
    expect(integer.code).toBe(1)
  })

  it("hides schema messages and values of a secret", async () => {
    const result = await runServer(root, { ...validValues, VITEHUB_TOKEN: shortToken })
    expect(result.code).toBe(1)
    expect(result.output).toContain("env.server.token")
    expect(result.output).toContain("The value does not match its schema.")
    expect(result.output).not.toContain(shortToken)
    expect(result.output).not.toContain("20 characters")
  })

  it("reports schema failures through inspectServerEnv() without values", async () => {
    const result = await runServer(root, { ...validValues, VITEHUB_API_URL: "http://api.example.com", VITEHUB_TOKEN: shortToken }, "inspect")
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output)).toEqual([
      ["env.server.apiUrl", "invalid"],
      ["env.server.retries", "available"],
      ["env.server.tags", "available"],
      ["env.server.token", "invalid"],
      ["env.server.withoutMetadata", "defaulted"],
    ])
    expect(result.output).not.toContain(shortToken)
  })

  it("generates schema output types and falls back to unknown without metadata", async () => {
    const generated = await readFile(join(root, ".vitehub", "types", "env.d.ts"), "utf8")
    expect(generated).toContain(`typeof import("../../env.schema.js")["retries"]`)
    const accessors = await readFile(join(root, ".vitehub", "types", "env-accessors.d.ts"), "utf8")
    expect(accessors).toContain(`typeof import("../../env.schema.js")["retries"]`)
    const program = createProgram({
      options: {
        module: ModuleKind.ESNext,
        moduleResolution: ModuleResolutionKind.Bundler,
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: ScriptTarget.ES2022,
      },
      rootNames: [
        join(root, "consumer.ts"),
        join(root, "root-consumer.ts"),
        join(root, "facade-consumer.ts"),
        join(root, ".vitehub", "types", "env.d.ts"),
        join(root, ".vitehub", "types", "env-accessors.d.ts"),
        join(root, ".vitehub", "env", "server.d.ts"),
      ],
    })
    expect(getPreEmitDiagnostics(program).map(diagnostic => flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  }, 30_000)

  it("fails at startup when the export is not a Standard Schema", async () => {
    const directory = await mkdtemp(join(temporaryRoot, "schema-from-missing-"))
    try {
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: "schema-from-missing", private: true, type: "module" }), "utf8")
      await writeFile(join(directory, "env.schema.ts"), schemaModule, "utf8")
      await writeFile(join(directory, "server.ts"), `import { useServerEnv } from "#vitehub/env/server"\nconsole.log(typeof useServerEnv)\n`, "utf8")
      await buildServer(directory, { value: env({ schema: env.schemaFrom("./env.schema.ts", "notASchema") }) })
      const result = await runServer(directory, { VITEHUB_VALUE: "x" })
      expect(result.code).toBe(1)
      expect(result.output).toContain("ENV_DECLARATION_INVALID")
      expect(result.output).toContain("is not a Standard Schema")
    }
    finally {
      await rm(directory, { force: true, recursive: true })
    }
  }, 60_000)

  it("rejects env.schemaFrom() outside generated Server Env", async () => {
    expect(() => createRuntimeRegistry({ value: env({ schema: env.schemaFrom("./env.schema.ts", "apiUrl") }) }, { path: "email.options" }))
      .toThrow(expect.objectContaining({ code: "ENV_DECLARATION_INVALID" }))
    await expect(resolveEnvEntries({ value: env({ mode: "build", schema: env.schemaFrom("./env.schema.ts") }) }, {
      context: createSourceContext({ env: { VITEHUB_VALUE: "x" }, mode: "build", rootDir: root }),
      exposure: "build public",
      section: "env.public",
      timing: "test",
    })).rejects.toMatchObject({ code: "ENV_DECLARATION_INVALID" })
  })

  it("rejects a type option and invalid references", () => {
    expect(() => createRuntimeRegistry({ value: env({ schema: env.schemaFrom("./env.schema.ts"), type: "string" }) }, { schemaModules: true }))
      .toThrow(expect.objectContaining({ code: "ENV_DECLARATION_INVALID" }))
    expect(() => env.schemaFrom("")).toThrow("non-empty module specifier")
    expect(() => env.schemaFrom("./env.schema.ts", "not-an-identifier")).toThrow("JavaScript identifier")
  })
})
