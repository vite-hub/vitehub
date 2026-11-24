import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { beforeAll, describe, expect, it } from "vitest"

import { runCodemod } from "../src/index.ts"

const execute = promisify(execFile)
const fixture = fileURLToPath(new URL("./fixtures/valibot-transform/input/", import.meta.url))
const temporaryRoot = fileURLToPath(new URL("../.vitest-tmp/", import.meta.url))

const buildScript = `import { createJiti } from "jiti"
import { hubEnv } from "@vite-hub/env/vite"
import { build } from "vite"

globalThis.defineNuxtConfig = config => config
const root = process.cwd()
const config = await createJiti(import.meta.url, { interopDefault: false }).import("./nuxt.config.ts", { default: true })
await build({
  build: { emptyOutDir: true, outDir: process.argv[2], rollupOptions: { output: { entryFileNames: "server.mjs" } }, ssr: "server.ts" },
  configFile: false,
  logLevel: "silent",
  plugins: [hubEnv(config.vitehub.env)],
  root,
})
`

const serverEntry = `import { usePublicEnv, useServerEnv } from "@vite-hub/env"

const serverEnv = useServerEnv()
console.log(JSON.stringify({
  allowedOrigins: serverEnv.allowedOrigins,
  apiBase: usePublicEnv().apiBase,
  apiSecretLength: serverEnv.apiSecret.unseal().length,
  port: serverEnv.port,
}))
`

let root: string

async function runNode(args: string[], values: Record<string, string>) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEHUB_") && !key.startsWith("NUXT_")))
  try {
    const result = await execute(process.execPath, args, { cwd: root, env: { ...environment, ...values }, timeout: 30_000 })
    return { code: 0, output: result.stdout + result.stderr }
  }
  catch (error) {
    const failure = error as { code?: number, stdout?: string, stderr?: string }
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` }
  }
}

describe("a migrated Valibot schema with transforms and checks", () => {
  beforeAll(async () => {
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd: fixture, dryRun: true })
    await mkdir(temporaryRoot, { recursive: true })
    root = await mkdtemp(join(temporaryRoot, "nsrc-schema-from-"))
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "nsrc-schema-from-app", private: true, type: "module" }), "utf8")
    await copyFile(join(fixture, "schema.ts"), join(root, "schema.ts"))
    for (const edit of run.result.edits) {
      if (edit.after === null || edit.path === "package.json") continue
      const code = edit.path === "nuxt.config.ts" ? edit.after.replaceAll("'vite-hub/env'", "'@vite-hub/env'") : edit.after
      await mkdir(dirname(join(root, edit.path)), { recursive: true })
      await writeFile(join(root, edit.path), code, "utf8")
    }
    await writeFile(join(root, "server.ts"), serverEntry, "utf8")
    await writeFile(join(root, "build.mjs"), buildScript, "utf8")
    const built = await runNode(["build.mjs", "dist"], {})
    expect(built.code, built.output).toBe(0)
  }, 60_000)

  it("keeps the transforms and the default", async () => {
    const result = await runNode(["dist/server.mjs"], { NUXT_API_SECRET: "0123456789abcdef", NUXT_ALLOWED_ORIGINS: "a,b" })
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(result.output)).toEqual({ allowedOrigins: ["a", "b"], apiBase: "https://api.example.com", apiSecretLength: 16, port: 3000 })
  })

  it("rejects a secret shorter than the schema allows", async () => {
    const result = await runNode(["dist/server.mjs"], { NUXT_API_SECRET: "short" })
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("Invalid env.server.apiSecret from env. The value does not match its schema.")
  })

  it("rejects a port below the schema minimum", async () => {
    const result = await runNode(["dist/server.mjs"], { NUXT_API_SECRET: "0123456789abcdef", NUXT_PORT: "0" })
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/env\.server\.port from env\. Invalid value: Expected >=1 but received 0/)
  })

  it("rejects a public API base that is not a URL when it builds", async () => {
    const result = await runNode(["build.mjs", "dist-invalid"], { NUXT_PUBLIC_API_BASE: "not-a-url" })
    expect(result.code).not.toBe(0)
    expect(result.output).toMatch(/Invalid env\.public\.apiBase: .*Invalid URL/)
  }, 30_000)
})
