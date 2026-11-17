import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createBlobCliSeeds } from "../src/cli.ts"
import { blobDevMaximumUploadBytes } from "../src/results.ts"
import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

import type { ViteHubCliContext, ViteHubCliSeedOptions } from "@vite-hub/internal/cli"

let rootDir: string

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "vitehub-blob-seed-"))
})

afterEach(async () => {
  await rm(rootDir, { force: true, recursive: true })
})

function stream() {
  let value = ""
  return { output: () => value, write: (chunk: string | Uint8Array) => (value += String(chunk), true) }
}

/** A fake app that answers each `blob.put` call like the Blob operation. */
function app() {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => {
    const { input } = operationRpcRequest(request?.body) as { input: { data: string, pathname: string } }
    return operationRpcResponse(request?.body, { ok: true, value: { created: true, object: { customMetadata: {}, httpEtag: "\"abc\"", httpMetadata: {}, pathname: input.pathname, size: atob(input.data).length, uploadedAt: "2026-11-17T10:00:00.000Z" }, store: "default" } })
  })
}

async function seed(options: Partial<ViteHubCliSeedOptions> = {}) {
  const fetch = app()
  const stdout = stream()
  const stderr = stream()
  const context = { cwd: rootDir, env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" }, fetch, rootDir, stderr, stdout } as unknown as ViteHubCliContext
  const exitCode = await createBlobCliSeeds()[0]!.run({ env: context.env, remote: false, ...options }, context)
  const calls = fetch.mock.calls.map(([url, request]) => ({ url: String(url), ...(operationRpcRequest(request?.body) as { input: Record<string, unknown>, operation: string }) }))
  return { calls, exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

async function write(file: string, text: string) {
  await mkdir(join(rootDir, file, ".."), { recursive: true })
  await writeFile(join(rootDir, file), text)
}

describe("Blob seed of vitehub seed", () => {
  it("uploads each file in server/seed/blob/ to the pathname of its path", async () => {
    await write("server/seed/blob/video/intro.en.vtt", "WEBVTT\n")
    await write("server/seed/blob/logo.svg", "<svg/>")
    await write("server/seed/blob/.DS_Store", "")

    const result = await seed()
    expect(result).toMatchObject({ exitCode: 0, stderr: "" })
    expect(result.calls.map(call => [call.operation, call.input])).toEqual([
      ["blob.put", { data: btoa("<svg/>"), pathname: "logo.svg" }],
      ["blob.put", { data: btoa("WEBVTT\n"), pathname: "video/intro.en.vtt" }],
    ])
  })

  it("writes the deployed app with --remote", async () => {
    await write("server/seed/blob/logo.svg", "<svg/>")
    const result = await seed({ remote: true, url: "https://app.example" })
    expect(result.exitCode).toBe(0)
    expect(result.calls[0]!.url).toMatch(/^https:\/\/app\.example\//)

    const missing = await seed({ remote: true })
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain("Pass --url <url>, or set `vitehub({ publicUrl })`.")
  })

  it("has nothing to seed without the folder", async () => {
    await expect(seed()).resolves.toMatchObject({ calls: [], exitCode: undefined })
  })

  it("stops at a file above the upload limit", async () => {
    await write("server/seed/blob/large.bin", "")
    await truncate(join(rootDir, "server/seed/blob/large.bin"), blobDevMaximumUploadBytes + 1)
    await write("server/seed/blob/small.txt", "ok")
    const result = await seed()
    expect(result).toMatchObject({ calls: [], exitCode: 1 })
    expect(result.stderr).toContain("accepts at most 8388608 bytes")
  })
})
