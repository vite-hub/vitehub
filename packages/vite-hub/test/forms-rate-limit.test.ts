import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as v from "valibot"
import { describe, expect, it, onTestFinished, vi } from "vitest"

import { defineForm } from "@vite-hub/forms"
import { createFormsHandler } from "@vite-hub/forms/runtime"
import { FORMS_VITE_PLUGIN_NAME } from "@vite-hub/forms/vite"

import { vitehub } from "../src/index.ts"

import type { Plugin } from "vite"

const contact = defineForm({ schema: v.object({ message: v.string() }), rateLimit: { limit: 2, window: "1m" } })

/** A KV store that two server processes share, such as Redis. */
function sharedKV() {
  const values = new Map<string, number>()
  return {
    values,
    increment: async (key: string) => {
      const value = (values.get(key) ?? 0) + 1
      values.set(key, value)
      return [undefined, value] as [undefined, number]
    },
    get: async (key: string) => [undefined, values.get(key)] as [undefined, unknown],
    delete: async (key: string) => {
      values.delete(key)
      return [undefined, undefined] as [undefined, undefined]
    },
  }
}

/** One server process: its own Rate Limit module state, the shared KV store, and the generated Forms route. */
async function serverProcess(storage: ReturnType<typeof sharedKV>) {
  vi.resetModules()
  const runtime = await import("@vite-hub/rate-limit/runtime")
  const { checkRateLimit } = await import("@vite-hub/rate-limit")
  runtime.setRateLimitRuntimeConfig({ driver: "kv" }, { driver: async () => "redis", storage, store: "default" })
  return {
    setRateLimitRuntimeConfig: runtime.setRateLimitRuntimeConfig,
    forms: createFormsHandler({ forms: { contact }, memory: true, rateLimit: checkRateLimit, context: () => ({ runtime: { clientAddress: "203.0.113.9" } }) }),
  }
}

const send = (handler: { fetch: (request: Request) => Promise<Response> }) => handler.fetch(new Request("https://site.test/api/_vitehub/forms/contact", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Hi" }),
}))

describe("Forms with Rate Limit on a shared KV store", () => {
  it("limits one address across two server processes", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    onTestFinished(() => info.mockRestore())
    const storage = sharedKV()
    const one = await serverProcess(storage)
    const two = await serverProcess(storage)
    // Each process has its own Rate Limit state, as two Node servers do.
    expect(one.setRateLimitRuntimeConfig).not.toBe(two.setRateLimitRuntimeConfig)

    expect((await send(one.forms)).status).toBe(201)
    expect((await send(two.forms)).status).toBe(201)
    const limited = await send(one.forms)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
    expect((await send(two.forms)).status).toBe(429)
    // One counter: the Rate Limit name `forms`, keyed by the form and the address.
    expect([...storage.values]).toEqual([[expect.stringMatching(/^rate-limit:forms:60000:form%3Acontact%3A203%2E0%2E113%2E9:\d+$/), 4]])
  })
})

describe("the generated Forms route", () => {
  async function handler(options: Parameters<typeof vitehub>[0]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vitehub-forms-rate-limit-"))
    await mkdir(join(root, "server/forms"), { recursive: true })
    await writeFile(join(root, "server/forms/contact.ts"), "export default {}\n")
    const plugin = (vitehub(options).flat() as Plugin[]).find(entry => entry.name === FORMS_VITE_PLUGIN_NAME)
    const config = plugin?.config
    if (!config || typeof config !== "object") throw new TypeError("The Forms plugin has no config handler.")
    await config.handler.call({} as never, { root }, { command: "serve", mode: "development" })
    return await readFile(join(root, ".vitehub/nitro/forms/handler.mjs"), "utf8")
  }

  it("counts in Rate Limit when Rate Limit counts in KV", async () => {
    expect(await handler({ host: "node", kv: true, rateLimit: true })).toContain("rateLimit: checkRateLimit,")
    expect(await handler({ host: "node", kv: true })).not.toContain("checkRateLimit")
    // Without KV, Rate Limit counts in the memory of the process too.
    expect(await handler({ host: "node", rateLimit: true })).not.toContain("checkRateLimit")
  })
})
