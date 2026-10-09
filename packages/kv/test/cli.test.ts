import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import { createKVCliContributor, runKVCli } from "../src/cli.ts"
import { kvDevHeader, kvDevHeaderValue, kvDevRoute, kvDevRuntimeRoute } from "../src/dev.ts"
import { kvDevRuntimeUnavailableMessage, registerKVDevEndpoint } from "../src/vite-dev.ts"
import { hubKv } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { KVDevServer } from "../src/vite-dev.ts"

const rootDir = "/app"

function stream() {
  let value = ""
  const bytes: Uint8Array[] = []
  return {
    bytes: () => bytes,
    output: () => value,
    write(chunk: string | Uint8Array) {
      if (typeof chunk !== "string") bytes.push(chunk)
      value += String(chunk)
      return true
    },
  }
}

function context(cwd = rootDir) {
  const stdout = stream()
  const stderr = stream()
  return { context: { cwd, env: {}, rootDir, stderr, stdout }, stderr, stdout }
}

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, init: { discovery?: Record<string, unknown>, status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status: init.status ?? 200 })
    : Response.json(init.discovery ?? { root: rootDir, runtime: "nitro" }))
}

function sentBody(fetch: ReturnType<typeof devServer>): unknown {
  return JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))
}

describe("KV review regressions", () => {
  it.each([
    { operation: "get", result: { found: true, type: "string", value: "empty key" } },
    { operation: "has", result: { exists: true } },
    { operation: "set", result: { created: true, type: "string" } },
    { operation: "del", result: { deleted: true } },
  ])("passes an empty key to $operation", async ({ operation, result }) => {
    const output = context()
    const fetch = devServer({ ...result, key: "", store: "default" })
    await expect(runKVCli([operation, "", ...(operation === "set" ? ["empty key"] : []), "--json"], output.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toMatchObject({ key: "", operation })
    expect(JSON.parse(output.stdout.output())).toMatchObject({ key: "" })
    expect(output.stderr.output()).toBe("")
  })

  it.each(["get", "has", "set", "del"])("still rejects a missing key for %s", async operation => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli([operation, "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("Missing key")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([false, true])("reports interrupted error bodies with JSON %s", async json => {
    const output = context()
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("body interrupted")) } }), { status: 500 })
    const fetch = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST" ? response : Response.json({ root: rootDir, runtime: "nitro" }))
    await expect(runKVCli(["get", "a", ...(json ? ["--json"] : [])], output.context, { fetch })).resolves.toBe(1)
    if (json) {
      expect(JSON.parse(output.stdout.output()).error.message).toContain("body interrupted")
      expect(output.stderr.output()).toBe("")
    }
    else expect(output.stderr.output()).toContain("body interrupted")
  })

  it("applies the request timeout to discovery", async () => {
    const output = context()
    const fetch = vi.fn((_url: string | URL | Request, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
    }))
    await expect(runKVCli(["list", "--timeout", "10", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(output.stderr.output()).toBe("")
  })

  it.each([
    ["set", "a", "b", "--ttl", "0", "--json"],
    ["set", "a", "@/missing-kv-input-file", "--json"],
    ["set", "a", "--json-value", "--json", "--", "-0"],
    ["set", "a", '{"nested":-0}', "--json-value", "--json"],
    ["set", "a", "1e400", "--json-value", "--json"],
    ["set", "a", '{"nested":1e400}', "--json-value", "--json"],
    ["list", "--cursor=", "--json"],
    ["list", "--cursor", "", "--json"],
  ])("returns JSON for validation and file failures: %j", async (...args) => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(args, output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: expect.any(String) } })
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["9007199254740993", '{"nested":[-9007199254740993]}'])("rejects unsafe JSON integers before discovery: %s", async value => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["set", "a", value, "--json-value", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("safe integer range")
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["9007199254740991", "1.5"])("preserves safe JSON numbers: %s", async value => {
    const output = context()
    const fetch = devServer({ created: true, key: "a", store: "default", type: "number" })
    await expect(runKVCli(["set", "a", value, "--json-value", "--json"], output.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toMatchObject({ value: Number(value) })
    expect(output.stderr.output()).toBe("")
  })

  it("keeps an empty continued list page off stdout", async () => {
    const output = context()
    const fetch = devServer({ cursor: "next", keys: [], limit: 2, prefix: "users:", store: "default", stores: ["default"] })
    await expect(runKVCli(["list", "--prefix", "users:"], output.context, { fetch })).resolves.toBe(0)
    expect(output.stdout.output()).toBe("")
    expect(output.stderr.output()).toBe("No keys on this page.\nMore keys exist. Next page: --cursor next\n")
  })

  it.each(["2147483648", "4294967296", "1e20", "1.5"])("rejects unsupported timeout before discovery: %s", async timeout => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["list", "--timeout", timeout, "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["line\nbreak", "line\rbreak", "line\u2028break", "line\u2029break"])("requires JSON to preserve line-breaking keys: %j", async key => {
    const result = { keys: ["ordinary", key], limit: 100, prefix: "", store: "default", stores: ["default"] }
    const human = context()
    await expect(runKVCli(["list"], human.context, { fetch: devServer(result) })).resolves.toBe(1)
    expect(human.stdout.output()).toBe("")
    expect(human.stderr.output()).toContain("Use --json")
    const json = context()
    await expect(runKVCli(["list", "--json"], json.context, { fetch: devServer(result) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output()).keys).toEqual(result.keys)
    expect(json.stderr.output()).toBe("")
  })

  it.each(["1e-400", '{"rate":1e-400}', '[1e-400]'])("rejects JSON underflow before discovery: %s", async value => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["set", "a", value, "--json-value", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("underflow to zero")
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["1.0000000000000001", "9007199254740991.1", "0.10000000000000001", "{\"rate\":1.0000000000000001}", "[9007199254740991.1]"])("rejects rounded normal JSON numbers before discovery: %s", async value => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["set", "--json-value", "--json", "--", "rate", value], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("change magnitude")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["4e-324", "-4e-324", '{"rate":4e-324}', '[-4e-324]', "9e-324"])("rejects rounded JSON subnormals before discovery: %s", async value => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["set", "--json-value", "--json", "--", "a", value], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("subnormal")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["", "hello", "hello\n", "hello\n\n", "first\nsecond", "héllo"])("prints strings unchanged: %j", async value => {
    const output = context()
    await expect(runKVCli(["get", "a"], output.context, { fetch: devServer({ found: true, key: "a", store: "default", type: "string", value }) })).resolves.toBe(0)
    expect(output.stdout.output()).toBe(value)
    expect(output.stderr.output()).toBe("")
  })

  it.each(["0", "0e-400", "0.000e400", "0.25", "0.1", "0.1000", "1.0", "100e-2", "-1.50e0", "5e-324", "-5e-324", "50e-325", "1e-323", "1e-308"])("preserves representable JSON numbers: %s", async value => {
    const output = context()
    const fetch = devServer({ created: true, key: "a", store: "default", type: "number" })
    await expect(runKVCli(["set", "--json-value", "--json", "--", "a", value], output.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toMatchObject({ value: Number(value) })
    expect(output.stderr.output()).toBe("")
  })

  it("rejects a found get response without type or value", async () => {
    const output = context()
    await expect(runKVCli(["get", "key", "--json"], output.context, { fetch: devServer({ found: true, key: "key", store: "default" }) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "The KV Dev response has an invalid result shape." } })
  })

  it("reports invalid binary payloads without throwing", async () => {
    const output = context()
    await expect(runKVCli(["get", "key", "--json"], output.context, { fetch: devServer({ encoding: "base64", found: true, key: "key", store: "default", value: "invalid!" }) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
  })

  it.each([false, true])("rejects malformed operation responses with json %s", async (json) => {
    const output = context()
    await expect(runKVCli(["list", ...(json ? ["--json"] : [])], output.context, { fetch: devServer({ keys: "invalid", store: "default" }) })).resolves.toBe(1)
    if (json) expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "The KV Dev response has an invalid result shape." } })
    else expect(output.stderr.output()).toContain("invalid result shape")
  })

  it.each([
    ["has", { key: "a", store: "default", exists: "yes" }],
    ["set", { key: "a", store: "default", created: true, type: 1 }],
    ["del", { key: "a", store: "default", deleted: "yes" }],
  ] as const)("rejects malformed %s responses", async (operation, result) => {
    const output = context()
    await expect(runKVCli([operation, "a", ...(operation === "set" ? ["value"] : []), "--json"], output.context, { fetch: devServer(result) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "The KV Dev response has an invalid result shape." } })
  })

  it("emits JSON for discovery failures", async () => {
    const output = context()
    await expect(runKVCli(["list", "--json"], output.context, { fetch: vi.fn(async () => { throw new Error("offline") }) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(output.stderr.output()).toBe("")
  })

  it("forwards fractional TTL seconds", async () => {
    const output = context()
    const fetch = devServer({ created: true, key: "a", store: "default", ttl: 1.5, type: "string" })
    await expect(runKVCli(["set", "a", "x", "--ttl", "1.5"], output.context, { fetch })).resolves.toBe(0)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ ttl: 1.5 })
  })
})

describe("vitehub kv", () => {
  it("lists keys as lines and as JSON", async () => {
    const result = { cursor: "next", keys: ["users:1", "users:2"], limit: 2, prefix: "users:", store: "default", stores: ["default", "cache"] }
    const human = context()
    const fetch = devServer(result)

    await expect(runKVCli(["list", "--prefix", "users:", "--limit=2", "--url", "http://127.0.0.1:4321"], human.context, { fetch })).resolves.toBe(0)

    expect(human.stdout.output()).toBe("users:1\nusers:2\n")
    expect(human.stderr.output()).toBe("More keys exist. Next page: --cursor next\n")
    const [discovery, operation] = fetch.mock.calls
    expect(String(discovery?.[0])).toBe(`http://127.0.0.1:4321${kvDevRoute}`)
    expect(operation?.[1]).toMatchObject({
      body: JSON.stringify({ operation: "list", limit: 2, prefix: "users:" }),
      headers: { "content-type": "application/json", [kvDevHeader]: kvDevHeaderValue },
      method: "POST",
    })

    const json = context()
    const jsonFetch = devServer(result)
    await expect(runKVCli(["list", "--cursor", "next", "--store", "cache", "--json"], json.context, { fetch: jsonFetch })).resolves.toBe(0)
    expect(sentBody(jsonFetch)).toEqual({ cursor: "next", operation: "list", store: "cache" })
    expect(JSON.parse(json.stdout.output())).toEqual(result)

    const empty = context()
    await expect(runKVCli(["list"], empty.context, { fetch: devServer({ keys: [], limit: 100, prefix: "", store: "default", stores: ["default"] }) })).resolves.toBe(0)
    expect(empty.stdout.output()).toBe("")
    expect(empty.stderr.output()).toBe("No keys in store default.\n")
  })

  it("prints values and reports missing keys with exit code 1", async () => {
    const text = context()
    await expect(runKVCli(["get", "greeting"], text.context, { fetch: devServer({ found: true, key: "greeting", store: "default", type: "string", value: "hello" }) })).resolves.toBe(0)
    expect(text.stdout.output()).toBe("hello")

    const object = context()
    await expect(runKVCli(["get", "settings"], object.context, { fetch: devServer({ found: true, key: "settings", store: "default", type: "object", value: { theme: "dark" } }) })).resolves.toBe(0)
    expect(object.stdout.output()).toBe("{\n  \"theme\": \"dark\"\n}\n")

    const bytes = context()
    await expect(runKVCli(["get", "raw"], bytes.context, { fetch: devServer({ encoding: "base64", found: true, key: "raw", store: "default", type: "bytes", value: "AP8B" }) })).resolves.toBe(0)
    expect(bytes.stdout.bytes()).toEqual([Uint8Array.from([0, 255, 1])])

    const missing = context()
    await expect(runKVCli(["get", "missing"], missing.context, { fetch: devServer({ found: false, key: "missing", store: "default" }) })).resolves.toBe(1)
    expect(missing.stdout.output()).toBe("")
    expect(missing.stderr.output()).toBe("Key missing was not found in store default.\n")

    const missingJson = context()
    await expect(runKVCli(["get", "missing", "--json"], missingJson.context, { fetch: devServer({ found: false, key: "missing", store: "default" }) })).resolves.toBe(1)
    expect(JSON.parse(missingJson.stdout.output())).toEqual({ found: false, key: "missing", store: "default" })
  })

  it("uses the exit code of has", async () => {
    const exists = context()
    await expect(runKVCli(["has", "a"], exists.context, { fetch: devServer({ exists: true, key: "a", store: "default" }) })).resolves.toBe(0)
    expect(exists.stdout.output()).toBe("Key a exists in store default.\n")

    const absent = context()
    await expect(runKVCli(["has", "a", "--json"], absent.context, { fetch: devServer({ exists: false, key: "a", store: "default" }) })).resolves.toBe(1)
    expect(JSON.parse(absent.stdout.output())).toEqual({ exists: false, key: "a", store: "default" })
  })

  it("prints what set and del changed", async () => {
    const created = context()
    const fetch = devServer({ created: true, key: "greeting", notice: "The fs-lite driver ignores TTL. The value does not expire.", store: "default", ttl: 60, type: "string" })
    await expect(runKVCli(["set", "greeting", "hello", "--ttl", "60"], created.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toEqual({ key: "greeting", operation: "set", ttl: 60, value: "hello" })
    expect(created.stdout.output()).toBe("Created key greeting in store default (string, TTL 60 s).\nThe fs-lite driver ignores TTL. The value does not expire.\n")

    const updated = context()
    const jsonValue = devServer({ created: false, key: "settings", store: "cache", type: "object" })
    await expect(runKVCli(["set", "settings", "{\"theme\":\"dark\"}", "--json-value", "--store", "cache"], updated.context, { fetch: jsonValue })).resolves.toBe(0)
    expect(sentBody(jsonValue)).toEqual({ key: "settings", operation: "set", store: "cache", value: { theme: "dark" } })
    expect(updated.stdout.output()).toBe("Updated key settings in store cache (object).\n")

    const deleted = context()
    await expect(runKVCli(["del", "greeting"], deleted.context, { fetch: devServer({ deleted: true, key: "greeting", store: "default" }) })).resolves.toBe(0)
    expect(deleted.stdout.output()).toBe("Deleted key greeting from store default.\n")

    const unchanged = context()
    await expect(runKVCli(["del", "greeting"], unchanged.context, { fetch: devServer({ deleted: false, key: "greeting", store: "default" }) })).resolves.toBe(0)
    expect(unchanged.stdout.output()).toBe("Key greeting was not found in store default. Deletion completed.\n")

    const json = context()
    await expect(runKVCli(["del", "greeting", "--json"], json.context, { fetch: devServer({ deleted: false, key: "greeting", store: "default" }) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual({ deleted: false, key: "greeting", store: "default" })
  })

  it("reads a value from a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vitehub-kv-cli-"))
    try {
      await writeFile(join(directory, "value.json"), "{\"items\":[1,2]}\n")
      const file = context(directory)
      const fetch = devServer({ created: true, key: "list", store: "default", type: "object" })
      await expect(runKVCli(["set", "list", "@value.json", "--json-value"], file.context, { fetch })).resolves.toBe(0)
      expect(sentBody(fetch)).toEqual({ key: "list", operation: "set", value: { items: [1, 2] } })

      const text = context(directory)
      const textFetch = devServer({ created: true, key: "raw", store: "default", type: "string" })
      await expect(runKVCli(["set", "raw", "@value.json"], text.context, { fetch: textFetch })).resolves.toBe(0)
      expect(sentBody(textFetch)).toMatchObject({ value: await readFile(join(directory, "value.json"), "utf8") })
    }
    finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("reports runtime errors on stderr, or as JSON with --json", async () => {
    const failure = { error: { code: "KV_STORE_NOT_FOUND", message: "KV store \"missing\" was not found. Stores: default." } }
    const human = context()
    await expect(runKVCli(["get", "a", "--store", "missing"], human.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(human.stdout.output()).toBe("")
    expect(human.stderr.output()).toBe("KV store \"missing\" was not found. Stores: default.\n")

    const json = context()
    await expect(runKVCli(["get", "a", "--store=missing", "--json"], json.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(failure)

    const guard = context()
    await expect(runKVCli(["list"], guard.context, {
      fetch: vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
        ? new Response("Forbidden KV Dev request.", { status: 403 })
        : Response.json({ root: rootDir, runtime: "nitro" })),
    })).resolves.toBe(1)
    expect(guard.stderr.output()).toBe("Forbidden KV Dev request.\n")
  })

  it("explains hosts that cannot reach the KV runtime", async () => {
    const unavailable = context()
    const fetch = devServer({}, { discovery: { message: kvDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" } })
    await expect(runKVCli(["list", "--json"], unavailable.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(unavailable.stdout.output())).toEqual({
      error: { code: "KV_DEV_RUNTIME_UNAVAILABLE", message: kvDevRuntimeUnavailableMessage },
    })

    const missing = context()
    await expect(runKVCli(["list"], missing.context, { fetch: vi.fn(async () => new Response("Not found", { status: 404 })) })).resolves.toBe(1)
    expect(missing.stderr.output()).toBe([
      "No Compatible Vite Development Server found at http://localhost:5173.",
      "`vitehub kv` needs a running Vite + Nitro Development Server with `kv` enabled. Nuxt and plain Vite are not supported.",
      "",
    ].join("\n"))
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const cases: Array<[string[], string]> = [
      [["get"], "Missing key."],
      [["set", "a"], "Missing value."],
      [["set", "a", "b", "c"], "Unexpected argument: c."],
      [["set", "a", "{", "--json-value"], "The value is not valid JSON"],
      [["set", "a", "b", "--ttl", "0"], "--ttl must be a positive number."],
      [["list", "--limit", "5000"], "--limit must be at most 1000."],
      [["list", "--ttl", "5"], "Unknown option: --ttl."],
      [["get", "a", "--prefix", "x"], "Unknown option: --prefix."],
      [["list", "--store"], "--store needs a value."],
      [["del", "a", "--store="], "--store needs a nonempty name."],
    ]
    for (const [args, message] of cases) {
      const invalid = context()
      await expect(runKVCli(args, invalid.context, { fetch })).resolves.toBe(1)
      expect(invalid.stderr.output(), args.join(" ")).toContain(message)
      expect(invalid.stderr.output()).toContain("Usage: vitehub kv")
    }
    const unknown = context()
    await expect(runKVCli(["clear"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toBe("Unknown kv command: clear\nCommands: list, get, has, set, del\n")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes one feature per command and no clear command", () => {
    const [namespace] = createKVCliContributor().namespaces
    expect(namespace?.name).toBe("kv")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["list", "get", "has", "set", "del"])
    expect(namespace?.features.find(feature => feature.name === "set")?.usage).toBe(
      "vitehub kv set <key> <value|@file> [--ttl <seconds>] [--json-value] [--store <name>] [--json] [--url <url>]",
    )
  })
})

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const server: KVDevServer = {
    config: { root: rootDir, server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server }
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: kvDevRoute,
  }) as unknown as IncomingMessage
  const done = new EventEmitter()
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  const res = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
    final(callback) {
      done.emit("end")
      callback()
    },
  }), {
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    statusCode: 200,
  })
  const ended = new Promise(resolve => done.once("end", resolve))
  middleware(req, res as unknown as ServerResponse, () => done.emit("end"))
  await ended
  return { body: Buffer.concat(chunks).toString("utf8"), headers, status: res.statusCode }
}

const guard = { [kvDevHeader]: kvDevHeaderValue }

describe("KV dev endpoint", () => {
  it("rejects requests without the guard header or from another origin", async () => {
    const { middlewares, server } = fakeServer()
    registerKVDevEndpoint(server)

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ body: "Forbidden KV Dev request.", status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guard, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guard, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guard, method: "DELETE" })).toMatchObject({ status: 405 })
  })

  it("returns 501 on hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    registerKVDevEndpoint(server)

    const discovery = await call(middlewares[0]!, { headers: guard, method: "GET" })
    expect(JSON.parse(discovery.body)).toEqual({ message: kvDevRuntimeUnavailableMessage, root: rootDir, runtime: "unavailable" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body)).toMatchObject({ error: { code: "KV_DEV_RUNTIME_UNAVAILABLE" } })
  })

  it("forwards operations into the Nitro environment under the Nitro base URL", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => Response.json({ body: await request.text(), url: request.url }))
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerKVDevEndpoint(server, { nitroBaseURL: () => "/app/" })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body)).toEqual({ root: rootDir, runtime: "nitro" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })

    expect(operation.status).toBe(200)
    expect(operation.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(operation.body)).toEqual({ body: "{\"operation\":\"list\"}", url: `http://localhost/app${kvDevRuntimeRoute}` })
    expect(dispatchFetch.mock.calls[0]?.[0].headers.get(kvDevHeader)).toBe(kvDevHeaderValue)
  })
})

describe("hubKv dev handler", () => {
  type ConfigHook = (config: Record<string, unknown>, env: { command: "build" | "serve", mode: string }) => Promise<void>

  function configHook(importBase?: string): ConfigHook {
    const plugin = hubKv({ base: ".data/kv", driver: "fs-lite" }, importBase ? { importBase } : {})
    const hook = plugin.config
    const handler = hook && "handler" in hook ? hook.handler : hook
    // SAFETY: The test calls the concrete hook with the Vite config fields that it reads.
    return handler as unknown as ConfigHook
  }

  it("adds the Nitro route only in serve mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-kv-vite-"))
    try {
      const build: Record<string, unknown> = { nitro: { handlers: [] }, root }
      await configHook()(build, { command: "build", mode: "production" })
      expect(build.nitro).toEqual({ handlers: [] })

      const serve: Record<string, unknown> = { nitro: { baseURL: "/app/", handlers: [] }, root }
      await configHook("vite-hub/_internal/kv")(serve, { command: "serve", mode: "development" })
      const handler = join(root, ".vitehub/nitro/kv/dev-handler.ts")
      expect(serve.nitro).toEqual({ baseURL: "/app/", handlers: [{ handler, route: kvDevRuntimeRoute }], plugins: [] })
      expect(await readFile(handler, "utf8")).toContain("import { handleKVDevRequest as handleViteHubDevRequest } from \"vite-hub/_internal/kv/runtime/dev\"")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("contributes the kv CLI namespace", () => {
    expect(hubKv().vitehub.cli).toEqual(expect.any(Function))
  })
})
