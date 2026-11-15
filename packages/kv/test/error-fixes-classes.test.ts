import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, expect, it } from "vitest"

import { kvErrorDiagnostics } from "../src/error-diagnostics.ts"
import { kvResult } from "../src/errors.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import { runKVOperation } from "../src/runtime/operations.ts"

const codes = {
  KV_INVALID_INPUT: kvErrorDiagnostics.KV_INVALID_INPUT({ problem: "value" }),
  KV_INVALID_VALUE: kvErrorDiagnostics.KV_INVALID_VALUE({ operation: "setIfAbsent", problem: "missing" }),
  KV_RESERVED_KEY: kvErrorDiagnostics.KV_RESERVED_KEY({ key: "vitehub:a", operation: "set" }),
  KV_VALUE_UNSUPPORTED: kvErrorDiagnostics.KV_VALUE_UNSUPPORTED(),
}

let base: string

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-kv-error-classes-"))
})

afterAll(async () => {
  await rm(base, { force: true, recursive: true })
})

it("gives each code that replaced a plain error a fix and its own docs page", () => {
  for (const [code, error] of Object.entries(codes)) {
    expect(error.code, code).toBe(code)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/kv/diagnostics/${code.toLowerCase()}`)
  }
})

it("returns KV_INVALID_VALUE from setIfAbsent() for an undefined value", async () => {
  const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
  const [error] = await kvResult("setIfAbsent", "default", () => storage.setIfAbsentItem!("ticket", undefined), ["KV_INVALID_VALUE"])
  expect(error).toMatchObject({ code: "KV_INVALID_VALUE", fix: expect.stringContaining("kv.delete()"), message: "kv.setIfAbsent() needs a value. Use kv.delete() to remove a key." })
  await storage.dispose()
})

it("gives each operation failure its code, fix, and HTTP status", async () => {
  const stores = [{ driver: "fs-lite", name: "default" }] as const
  await expect(runKVOperation("set", { key: "vitehub:state", value: 1 }, stores)).rejects.toMatchObject({
    code: "KV_RESERVED_KEY",
    fix: expect.stringContaining("Use another key"),
    status: 403,
  })
  await expect(runKVOperation("list", { limit: 5_000 }, stores)).rejects.toMatchObject({
    code: "KV_INVALID_INPUT",
    fix: expect.stringContaining("`limit`"),
    status: 400,
    statusMessage: "limit must be at most 1000.",
  })
  await expect(runKVOperation("get", { key: "a" }, [])).rejects.toMatchObject({ code: "KV_DISABLED", status: 409 })
})
