import { execFile } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/nitro")

async function cleanupPlayground() {
  await rm(join(playgroundDir, ".output"), { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
  await rm(join(playgroundDir, ".wrangler"), { force: true, recursive: true, maxRetries: 10, retryDelay: 50 })
}

beforeAll(async () => {
  await cleanupPlayground()
})

afterAll(async () => {
  await cleanupPlayground()
})

describe("Nitro Cloudflare KV output", () => {
  it("writes kv namespace bindings when KV_NAMESPACE_ID is provided", async () => {
    await execFileAsync("pnpm", ["exec", "nitro", "build", "--preset", "cloudflare-module"], {
      cwd: playgroundDir,
      env: {
        ...process.env,
        KV_NAMESPACE_ID: "kv-namespace",
      },
    })

    const wrangler = JSON.parse(await readFile(join(playgroundDir, ".output", "server", "wrangler.json"), "utf8"))
    expect(wrangler.kv_namespaces).toContainEqual({
      binding: "KV",
      id: "kv-namespace",
    })
  }, 30_000)
})
