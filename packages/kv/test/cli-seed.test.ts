import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createKVCliContributor } from "../src/cli.ts"
import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

import type { ViteHubCliContext, ViteHubCliSeedOptions } from "@vite-hub/internal/cli"

let rootDir: string

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "vitehub-kv-seed-"))
})

afterEach(async () => {
  await rm(rootDir, { force: true, recursive: true })
})

function stream() {
  let value = ""
  return { output: () => value, write: (chunk: string | Uint8Array) => (value += String(chunk), true) }
}

/** A fake app that answers each `kv.set` call like the KV operation. */
function app() {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => {
    const { input } = operationRpcRequest(request?.body) as { input: { key: string, value: unknown } }
    return operationRpcResponse(request?.body, { ok: true, value: { created: true, key: input.key, store: "default", type: typeof input.value } })
  })
}

async function seed(options: Partial<ViteHubCliSeedOptions> = {}) {
  const fetch = app()
  const stdout = stream()
  const stderr = stream()
  const context = { cwd: rootDir, env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" }, fetch, rootDir, stderr, stdout } as unknown as ViteHubCliContext
  const exitCode = await createKVCliContributor().seeds![0]!.run({ env: context.env, remote: false, ...options }, context)
  const calls = fetch.mock.calls.map(([url, request]) => ({ url: String(url), ...(operationRpcRequest(request?.body) as { input: Record<string, unknown>, operation: string }) }))
  return { calls, exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

async function write(file: string, text: string) {
  await mkdir(join(rootDir, file, ".."), { recursive: true })
  await writeFile(join(rootDir, file), text)
}

describe("KV seed of vitehub seed", () => {
  it("writes each file in server/seed/kv/ to the key of its path", async () => {
    await write("server/seed/kv/habits.json", JSON.stringify([{ done: false, title: "Water the plants" }]))
    await write("server/seed/kv/settings/theme.json", "\"dark\"")
    await write("server/seed/kv/welcome.txt", "Hello from the seed.\n")
    await write("server/seed/kv/.gitkeep", "")

    const result = await seed()
    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.calls.map(call => [call.operation, call.input])).toEqual([
      ["kv.set", { key: "habits", value: [{ done: false, title: "Water the plants" }] }],
      ["kv.set", { key: "settings/theme", value: "dark" }],
      ["kv.set", { key: "welcome", value: "Hello from the seed.\n" }],
    ])
    expect(result.stdout).toBe("Created key habits in store default (object).\nCreated key settings/theme in store default (string).\nCreated key welcome in store default (string).\n")
  })

  it("writes the deployed app with --remote", async () => {
    await write("server/seed/kv/habits.json", "[]")
    const result = await seed({ remote: true, timeout: 5000, url: "https://app.example" })
    expect(result.exitCode).toBe(0)
    expect(result.calls[0]!.url).toMatch(/^https:\/\/app\.example\//)

    const missing = await seed({ remote: true })
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain("Pass --url <url>, or set `vitehub({ publicUrl })`.")
    expect(missing.calls).toEqual([])
  })

  it("has nothing to seed without the folder", async () => {
    await expect(seed()).resolves.toMatchObject({ calls: [], exitCode: undefined })
  })

  it("refuses two files with the same key, and invalid JSON, before it writes", async () => {
    await write("server/seed/kv/habits.json", "[]")
    await write("server/seed/kv/habits.txt", "text")
    const twice = await seed()
    expect(twice).toMatchObject({ calls: [], exitCode: 1 })
    expect(twice.stderr).toContain("server/seed/kv/habits.json and server/seed/kv/habits.txt are both the KV key habits.")

    await rm(join(rootDir, "server/seed/kv/habits.txt"))
    await write("server/seed/kv/habits.json", "[")
    const invalid = await seed()
    expect(invalid).toMatchObject({ calls: [], exitCode: 1 })
    expect(invalid.stderr).toContain("The value is not valid JSON")
  })
})
