import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { healthVitePlugin, renderHealthHandler } from "../src/health-vite.ts"

type Handler = { fetch(): Promise<Response> }

/** Evaluates the generated handler with a stub for `pingDatabases()`. */
function handler(database: boolean, ping: () => Promise<Record<string, boolean>> = async () => ({})): Handler {
  const source = renderHealthHandler({ commit: "abc123", database })
    .replace(`import { pingDatabases } from "@vite-hub/database/runtime/registry"`, "")
    .replace("export default", "return")
  // eslint-disable-next-line no-new-func -- evaluates the generated module body without a loader.
  return new Function("pingDatabases", source)(ping) as Handler
}

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("health route", () => {
  it("answers ok and the commit, and is never cached", async () => {
    const response = await handler(false).fetch()

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ ok: true, commit: "abc123" })
  })

  it("pings each Database and answers 503 without error text when one fails", async () => {
    const healthy = await handler(true, async () => ({ default: true })).fetch()
    expect(healthy.status).toBe(200)
    expect(await healthy.json()).toEqual({ ok: true, commit: "abc123", databases: { default: true } })

    const failing = await handler(true, async () => ({ default: true, analytics: false })).fetch()
    expect(failing.status).toBe(503)
    expect(await failing.json()).toEqual({ ok: false, commit: "abc123", databases: { default: true, analytics: false } })
  })

  it("registers the route with the commit of the build", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "def456")
    const root = await mkdtemp(join(tmpdir(), "vitehub-health-"))
    roots.push(root)
    const config: Record<string, unknown> = { root }

    await (healthVitePlugin({}, { database: false }).config as (config: object) => Promise<void>)(config)
    const custom: Record<string, unknown> = { root }
    await (healthVitePlugin({ route: "/api/health" }, { database: false }).config as (config: object) => Promise<void>)(custom)

    const file = join(root, ".vitehub/nitro/health.mjs")
    expect(config.nitro).toMatchObject({ handlers: [{ handler: file, route: "/api/_vitehub/health" }] })
    expect(custom.nitro).toMatchObject({ handlers: [{ handler: file, route: "/api/health" }] })
    expect(await readFile(file, "utf8")).toContain(`const commit = "def456"`)
  })
})
