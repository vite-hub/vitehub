import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { createBuilder } from "vite"
import { afterEach, describe, expect, it, vi } from "vitest"

import { vitehub } from "../src/index.ts"
import { readViteHubVersion } from "../src/version.ts"
import { startBuiltServer } from "./content-preview-fixture.ts"
import { createProject } from "./support/content-cms.ts"

const cwd = process.cwd()

afterEach(() => {
  process.chdir(cwd)
  vi.unstubAllEnvs()
})

describe("health route in a built Nitro 3 app", () => {
  it("answers with the build commit and checks the Database, KV, and Blob", async () => {
    const root = await createProject({
      "package.json": JSON.stringify({ name: "health-build", private: true, type: "module" }),
      "server/databases/default.ts": "import { defineDatabase } from 'vite-hub/database'\nexport default defineDatabase({ schema: {} })\n",
      "server/routes/__vitehub_fixture_ready.ts": "export default () => 'ok'\n",
    })
    vi.stubEnv("COMMIT_REF", "0123abc")
    const { nitro } = (await import("nitro/vite" as string)) as { nitro: () => unknown }
    const app = [vitehub({ blob: { driver: "fs", base: join(root, "uploads") }, database: true, health: { route: "/api/health" }, host: "node", kv: true }), nitro()]
    const builder = await createBuilder({ cacheDir: `${root}.vite-cache`, logLevel: "silent", plugins: app, root } as never)
    await builder.buildApp()

    // The local SQLite file is relative to the working directory, as when the app runs.
    process.chdir(root)
    const server = await startBuiltServer(root, {})
    try {
      const response = await server.fetch("/api/health")
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({ ok: true, commit: "0123abc", vitehub: readViteHubVersion(), checks: { database: { default: true }, kv: { default: true }, blob: { default: true } } })

      await writeFile(join(root, "uploads"), "not a directory")
      const failing = await server.fetch("/api/health")
      expect(failing.status).toBe(503)
      expect(await failing.json()).toMatchObject({ ok: false, checks: { blob: { default: false } } })
    }
    finally {
      server.close()
    }
  }, 120_000)
})
