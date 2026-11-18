import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { healthVitePlugin, renderHealthHandler, type HealthTargets } from "../src/health-vite.ts"
import { readViteHubVersion } from "../src/version.ts"

type Handler = { fetch(): Promise<Response> }
type Modules = Record<string, Record<string, unknown>>

/** Evaluates the generated handler, with stubs for the modules that it imports. */
function handler(targets: Partial<HealthTargets>, modules: Modules = {}): Handler {
  const source = renderHealthHandler({ commit: "abc123", vitehub: "0.0.9", database: false, kv: [], blob: [], ...targets })
    .replace(/\bimport\(/g, "load(")
    .replace("export default", "return")
  const load = async (specifier: string) => modules[specifier]
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  return new Function("load", source)(load) as Handler
}

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("health route", () => {
  it("answers ok, the commit, and the ViteHub version, and is never cached", async () => {
    const response = await handler({}).fetch()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ ok: true, commit: "abc123", vitehub: "0.0.9" })
  })

  it("answers the app version when its package.json has one", async () => {
    const source = renderHealthHandler({ version: "1.4.0", commit: null, vitehub: "0.0.9", database: false, kv: [], blob: [] }).replace("export default", "return")
    // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
    const response = await (new Function(source)() as Handler).fetch()
    expect(await response.json()).toEqual({ ok: true, version: "1.4.0", commit: null, vitehub: "0.0.9" })
  })

  it("checks each Database, KV store, and Blob store, and answers 503 without error text when one fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const failure = new Error("connect ECONNREFUSED redis://user:secret@cache:6379")
    const reads: string[] = []
    const store = (kind: string, failing?: string) => (name: string) => {
      const read = async (key: string) => {
        reads.push(`${kind}:${name}:${key}`)
        return name === failing ? [failure, undefined] : [undefined, null]
      }
      return { has: read, head: read }
    }
    const modules = (failingKV?: string): Modules => ({
      "@vite-hub/database/runtime/registry": { pingDatabases: async () => ({ default: true }) },
      "vite-hub/kv": { kv: { store: store("kv", failingKV) } },
      "vite-hub/blob": { blob: { store: store("blob") } },
    })
    const targets = { database: true, kv: ["default", "sessions"], blob: ["default"] }

    const healthy = await handler(targets, modules()).fetch()
    expect(healthy.status).toBe(200)
    expect(await healthy.json()).toEqual({
      ok: true,
      commit: "abc123",
      vitehub: "0.0.9",
      checks: { database: { default: true }, kv: { default: true, sessions: true }, blob: { default: true } },
    })
    expect(reads).toEqual(["kv:default:vitehub-health-check", "kv:sessions:vitehub-health-check", "blob:default:vitehub-health-check"])

    const failing = await handler(targets, modules("sessions")).fetch()
    expect(failing.status).toBe(503)
    const body = await failing.text()
    expect(JSON.parse(body)).toMatchObject({ ok: false, checks: { kv: { default: true, sessions: false } } })
    expect(body).not.toContain("secret")
    expect(log).toHaveBeenCalledWith("[vitehub] KV store \"sessions\" did not answer the health check.", failure)
  })

  it("counts a store that does not answer within 2 seconds as failed", async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const modules: Modules = { "vite-hub/blob": { blob: { store: () => ({ head: () => new Promise(() => {}) }) } } }

    const pending = handler({ blob: ["uploads"] }, modules).fetch()
    await vi.advanceTimersByTimeAsync(2_000)
    const response = await pending

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, commit: "abc123", vitehub: "0.0.9", checks: { blob: { uploads: false } } })
    expect(log).toHaveBeenCalledWith("[vitehub] Blob store \"uploads\" did not answer the health check.", new Error("No answer within 2000 ms."))
  })

  it("registers the route with the app version, the commit of the build, and the installed ViteHub version", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "def456")
    const root = await mkdtemp(join(tmpdir(), "vitehub-health-"))
    roots.push(root)
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "ferry-times", version: "1.4.0" }))
    const config: Record<string, unknown> = { root }
    const targets = { database: false, kv: [], blob: [] }

    await (healthVitePlugin({}, targets).config as (config: object) => Promise<void>)(config)
    const custom: Record<string, unknown> = { root }
    await (healthVitePlugin({ route: "/api/health" }, targets).config as (config: object) => Promise<void>)(custom)

    const file = join(root, ".vitehub/nitro/health.mjs")
    expect(config.nitro).toMatchObject({ handlers: [{ handler: file, route: "/_vitehub/health" }] })
    expect(custom.nitro).toMatchObject({ handlers: [{ handler: file, route: "/api/health" }] })
    const source = await readFile(file, "utf8")
    expect(source).toContain(`const version = "1.4.0"`)
    expect(source).toContain(`const commit = "def456"`)
    expect(source).toContain(`const vitehub = ${JSON.stringify(readViteHubVersion())}`)
  })
})
