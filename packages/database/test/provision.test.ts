import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createDatabaseProvisionStep } from "../src/provision.ts"

import type { ProvisionContext } from "@vite-hub/internal/provision"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

async function createApp() {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-db-provision-"))
  directories.push(rootDir)
  const dir = join(rootDir, "server", "databases", "primary")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "config.ts"), [
    "import { defineDatabase } from '@vite-hub/database'",
    "export default defineDatabase({",
    "  name: 'primary',",
    "  cloudflare: { binding: 'DB', databaseName: 'vitehub-playground-db' },",
    "  schema: {},",
    "})",
    "",
  ].join("\n"), "utf8")
  return rootDir
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
}

function provisionContext(fetchImpl: typeof globalThis.fetch): ProvisionContext {
  return {
    env: { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token" },
    fetch: fetchImpl,
    logger: { log: () => {}, warn: () => {} },
  }
}

describe("database provision step", () => {
  it("does not create a D1 database that already exists and writes back its id", async () => {
    const rootDir = await createApp()
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("must not create existing database")
      return jsonResponse({ success: true, result: [{ name: "vitehub-playground-db", uuid: "uuid-1" }] })
    }) as unknown as typeof globalThis.fetch

    const actions = await createDatabaseProvisionStep(() => rootDir).plan(provisionContext(fetchImpl))
    expect(actions).toHaveLength(1)
    expect(actions[0]!.exists).toBe(true)

    const result = await actions[0]!.apply()
    expect(result.ids).toEqual({ cloudflare: { d1: { primary: "uuid-1" } } })
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  it("creates a missing D1 database and returns its id keyed by definition name", async () => {
    const rootDir = await createApp()
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ success: true, result: { name: "vitehub-playground-db", uuid: "uuid-new" } })
      return jsonResponse({ success: true, result: [] })
    }) as unknown as typeof globalThis.fetch

    const actions = await createDatabaseProvisionStep(() => rootDir).plan(provisionContext(fetchImpl))
    expect(actions[0]!.exists).toBe(false)
    const result = await actions[0]!.apply()
    expect(result.ids).toEqual({ cloudflare: { d1: { primary: "uuid-new" } } })
  })
})
