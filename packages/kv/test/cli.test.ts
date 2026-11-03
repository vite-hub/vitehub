import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createKVCliContributor, runKVCli } from "../src/cli.ts"
import { hubKv } from "../src/vite.ts"

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
  return { context: { cwd, env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" } as NodeJS.ProcessEnv, rootDir, stderr, stdout }, stderr, stdout }
}

/**
 * A fake app: it answers the operation RPC. A result is the value of the operation. With `status`, the result is an
 * error body, `{ error: { code?, message } }`, which the RPC reports as the failure fields.
 */
function devServer(result: unknown, init: { status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, _request?: RequestInit) => {
    const status = init.status ?? 200
    if (status < 400) return Response.json({ ok: true, value: result }, { status })
    const error = (result as { error: { code?: string, message: string } }).error
    return Response.json({ ok: false, code: error.code ?? "KV_FAILED", message: error.message, status }, { status })
  })
}

/** The operation and input that a command sent, with the operation name as `operation`. */
function sentBody(fetch: ReturnType<typeof devServer>): Record<string, unknown> {
  const { input, operation } = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { input: Record<string, unknown>, operation: string }
  return { ...input, operation: operation.replace(/^kv\./, "") }
}

describe("KV delete confirmation", () => {
  it.each([{ target: [] }, { target: ["--url", "https://app.example/base/"] }])("refuses an unconfirmed deletion: $target", async ({ target }) => {
    const output = context()
    const fetch = devServer({ deleted: true, key: "a", store: "default" })
    await expect(runKVCli(["del", "a", ...target], output.context, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("was not confirmed")
    expect(output.stderr.output()).toContain("--yes")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reports a declined confirmation as JSON without sending a request", async () => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["del", "a", "--json", "--url", "https://app.example"], output.context, { confirm: () => false, fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toMatchObject({ error: { code: "KV_NOT_CONFIRMED" } })
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("asks about the selected object, store and deployment, then sends confirmation", async () => {
    const output = context()
    const fetch = devServer({ deleted: true, key: "a", store: "archive" })
    const confirm = vi.fn(async (_question: string) => true)
    await expect(runKVCli(["del", "a", "--store", "archive", "--url", "https://app.example/base/"], output.context, { confirm, fetch })).resolves.toBe(0)
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.[0]).toEqual(expect.stringContaining("a"))
    expect(confirm.mock.calls[0]?.[0]).toEqual(expect.stringContaining("archive"))
    expect(confirm.mock.calls[0]?.[0]).toEqual(expect.stringContaining("https://app.example/base/"))
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-vitehub-confirmation")).toBe("confirmed")
    expect(sentBody(fetch)).toEqual({ operation: "del", key: "a", store: "archive" })
  })

  it.each(["--yes", "-y"])("deletes with %s without prompting", async flag => {
    const output = context()
    const fetch = devServer({ deleted: true, key: "a", store: "default" })
    const confirm = vi.fn(() => false)
    await expect(runKVCli(["del", "a", flag, "--url", "https://app.example"], output.context, { confirm, fetch })).resolves.toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-vitehub-confirmation")).toBe("confirmed")
  })

  it("does not treat a literal --yes after -- as confirmation", async () => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["del", "--", "--yes"], output.context, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("was not confirmed")
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("KV review regressions", () => {
  it.each([
    { operation: "get", result: { found: true, type: "string", value: "empty key" } },
    { operation: "has", result: { exists: true } },
    { operation: "set", result: { created: true, type: "string" } },
    { operation: "del", result: { deleted: true } },
  ])("passes an empty key to $operation", async ({ operation, result }) => {
    const output = context()
    const fetch = devServer({ ...result, key: "", store: "default" })
    await expect(runKVCli([operation, "", ...(operation === "set" ? ["empty key"] : []), ...(operation === "del" ? ["--yes"] : []), "--json"], output.context, { fetch })).resolves.toBe(0)
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

  it("applies the request timeout", async () => {
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

  it.each(["9007199254740993", '{"nested":[-9007199254740993]}'])("rejects unsafe JSON integers before it calls the app: %s", async value => {
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

  it.each(["2147483648", "4294967296", "1e20", "1.5"])("rejects unsupported timeout before it calls the app: %s", async timeout => {
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

  it.each(["1e-400", '{"rate":1e-400}', '[1e-400]'])("rejects JSON underflow before it calls the app: %s", async value => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["set", "a", value, "--json-value", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("underflow to zero")
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["1.0000000000000001", "9007199254740991.1", "0.10000000000000001", "{\"rate\":1.0000000000000001}", "[9007199254740991.1]"])("rejects rounded normal JSON numbers before it calls the app: %s", async value => {
    const output = context()
    const fetch = vi.fn()
    await expect(runKVCli(["set", "--json-value", "--json", "--", "rate", value], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output()).error.message).toContain("change magnitude")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["4e-324", "-4e-324", '{"rate":4e-324}', '[-4e-324]', "9e-324"])("rejects rounded JSON subnormals before it calls the app: %s", async value => {
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
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "The kv operation answered with an invalid result shape." } })
  })

  it("reports invalid binary payloads without throwing", async () => {
    const output = context()
    await expect(runKVCli(["get", "key", "--json"], output.context, { fetch: devServer({ encoding: "base64", found: true, key: "key", store: "default", value: "invalid!" }) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
  })

  it.each([false, true])("rejects malformed operation responses with json %s", async (json) => {
    const output = context()
    await expect(runKVCli(["list", ...(json ? ["--json"] : [])], output.context, { fetch: devServer({ keys: "invalid", store: "default" }) })).resolves.toBe(1)
    if (json) expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "The kv operation answered with an invalid result shape." } })
    else expect(output.stderr.output()).toContain("invalid result shape")
  })

  it.each([
    ["has", { key: "a", store: "default", exists: "yes" }],
    ["set", { key: "a", store: "default", created: true, type: 1 }],
    ["del", { key: "a", store: "default", deleted: "yes" }],
  ] as const)("rejects malformed %s responses", async (operation, result) => {
    const output = context()
    await expect(runKVCli([operation, "a", ...(operation === "set" ? ["value"] : []), ...(operation === "del" ? ["--yes"] : []), "--json"], output.context, { fetch: devServer(result) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "The kv operation answered with an invalid result shape." } })
  })

  it("emits JSON when the app cannot be reached", async () => {
    const output = context()
    await expect(runKVCli(["list", "--json"], output.context, { fetch: vi.fn(async () => { throw new Error("offline") }) })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(output.stderr.output()).toBe("")
  })

  it("forwards fractional TTL seconds", async () => {
    const output = context()
    const fetch = devServer({ created: true, key: "a", store: "default", ttl: 1.5, type: "string" })
    await expect(runKVCli(["set", "a", "x", "--ttl", "1.5"], output.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toMatchObject({ ttl: 1.5 })
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
    const [call] = fetch.mock.calls
    expect(String(call?.[0])).toBe("http://127.0.0.1:4321/_vitehub/rpc/__call")
    expect(call?.[1]).toMatchObject({
      body: JSON.stringify({ operation: "kv.list", input: { limit: 2, prefix: "users:" } }),
      method: "POST",
    })
    expect(new Headers(call?.[1]?.headers).get("x-vitehub-console")).toBe("1")

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
    await expect(runKVCli(["del", "greeting", "--yes"], deleted.context, { fetch: devServer({ deleted: true, key: "greeting", store: "default" }) })).resolves.toBe(0)
    expect(deleted.stdout.output()).toBe("Deleted key greeting from store default.\n")

    const unchanged = context()
    await expect(runKVCli(["del", "greeting", "--yes"], unchanged.context, { fetch: devServer({ deleted: false, key: "greeting", store: "default" }) })).resolves.toBe(0)
    expect(unchanged.stdout.output()).toBe("Key greeting was not found in store default. Deletion completed.\n")

    const json = context()
    await expect(runKVCli(["del", "greeting", "--json", "--yes"], json.context, { fetch: devServer({ deleted: false, key: "greeting", store: "default" }) })).resolves.toBe(0)
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

    const forbidden = context()
    await expect(runKVCli(["list"], forbidden.context, {
      fetch: vi.fn(async () => Response.json({ ok: false, code: "INTERNAL_R0023", message: "No access to the kv section.", status: 403 }, { status: 403 })),
    })).resolves.toBe(1)
    expect(forbidden.stderr.output()).toContain("No access to the kv section.")
  })

  it("says to start the dev server when none runs for the project", async () => {
    const missing = context()
    missing.context.env = {}
    await expect(runKVCli(["list"], missing.context, { fetch: vi.fn() })).resolves.toBe(1)
    expect(missing.stderr.output()).toContain("No dev server is running for /app.")
    expect(missing.stderr.output()).toContain("vite dev")
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

describe("hubKv", () => {
  it("contributes the kv operations and the CLI namespace", async () => {
    const plugin = hubKv()
    expect(plugin.vitehub.cli).toEqual(expect.any(Function))
    expect(plugin.vitehub.operations).toEqual([expect.objectContaining({ export: "kvOperations", module: "@vite-hub/kv/operations" })])
    const operations = await plugin.vitehub.operations[0]!.load!() as Array<{ name: string }>
    expect(operations.map(operation => operation.name)).toEqual(["kv.list", "kv.get", "kv.has", "kv.set", "kv.del"])
  })
})
