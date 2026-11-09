import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import postgres from "postgres"
import { afterEach, describe, expect, it } from "vitest"

// Needs a live Postgres, for example:
// docker run -d -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:17
// VITEHUB_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:55432/postgres
const url = process.env.VITEHUB_TEST_POSTGRES_URL
const dist = new URL("../dist/", import.meta.url)
const processes = 4

interface ServerResult {
  errors: string[]
  started: boolean
  warnings: number
}

// One server: install the runtime config, then let `installOpenWorkflow()` set up the schema and start the worker.
const serverScript = `
const [{ setWorkflowRuntimeConfig, setWorkflowRuntimeRegistry }, { installOpenWorkflow }] = await Promise.all([
  import(${JSON.stringify(new URL("runtime/state.js", dist).href)}),
  import(${JSON.stringify(new URL("runtime/openworkflow-worker.js", dist).href)}),
])
let warnings = 0
console.warn = () => { warnings++ }
console.error = () => {}
const errors = []
const close = []
const app = {
  captureError: error => errors.push(String(error.cause?.message ?? error.message)),
  hooks: { hook: (_name, callback) => close.push(callback) },
}
setWorkflowRuntimeConfig({ postgres: { schema: process.env.SCHEMA, url: process.env.DATABASE_URL }, provider: "openworkflow" })
setWorkflowRuntimeRegistry({ ping: async () => ({ default: { handler: async () => "pong" } }) })
// Start every server at the same moment, after its modules load.
await new Promise(resolve => setTimeout(resolve, Number(process.env.START_AT) - Date.now()))
const started = await installOpenWorkflow(app)
for (const callback of close) await callback()
process.stdout.write(JSON.stringify({ errors, started, warnings }))
process.exit(0)
`

function runServer(file: string, schema: string, startAt: number): Promise<ServerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, DATABASE_URL: url, SCHEMA: schema, START_AT: String(startAt) },
      stdio: ["ignore", "pipe", "inherit"],
    })
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => { output += chunk })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Server process exited with ${code}: ${output}`))
      else resolve(JSON.parse(output) as ServerResult)
    })
  })
}

describe.skipIf(!url)("OpenWorkflow on several Postgres servers", () => {
  const cleanups: Array<() => Promise<unknown>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  it(`starts a worker in each of ${processes} servers that start together on an empty schema`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-openworkflow-start-"))
    cleanups.push(() => rm(directory, { force: true, recursive: true }))
    const file = join(directory, "server.mjs")
    await writeFile(file, serverScript)
    const schema = `vitehub_start_${randomUUID().replaceAll("-", "")}`
    const sql = postgres(url!, { max: 1, onnotice: () => {} })
    cleanups.push(async () => {
      await sql.unsafe(`drop schema if exists "${schema}" cascade`)
      await sql.end()
    })

    // Leave time for every process to load its modules before the shared start time.
    const startAt = Date.now() + 3_000
    const results = await Promise.all(Array.from({ length: processes }, () => runServer(pathToFileURL(file).pathname, schema, startAt)))

    expect(results.map(result => result.errors)).toEqual(Array.from({ length: processes }, () => []))
    // The lock lets each server set up the schema on its first attempt, without the start retry.
    expect(results.map(result => result.warnings)).toEqual(Array.from({ length: processes }, () => 0))
    expect(results.map(result => result.started)).toEqual(Array.from({ length: processes }, () => true))
    const [migrations] = await sql.unsafe(`select count(*)::int as count from "${schema}"."openworkflow_migrations"`)
    expect(migrations?.count).toBeGreaterThan(0)
  }, 60_000)
})
