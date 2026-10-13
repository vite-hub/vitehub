import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"

import { createBlobCliNamespaces, runBlobCli } from "../src/cli.ts"
import { blobDevFileHeader, blobDevHeader, blobDevHeaderValue, blobDevMaximumUploadBytes, blobDevRoute, blobDevRuntimeRoute, blobDevTokenNamespace, blobDevTokenServerHeader } from "../src/dev.ts"
import { blobDevRuntimeUnavailableMessage, registerBlobDevEndpoint } from "../src/vite-dev.ts"
import { hubBlob } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { BlobDevServer } from "../src/vite-dev.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

let cwd: string
let devToken: { serverId: string, token: string }

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "vitehub-blob-cli-"))
  devToken = await createViteHubDevToken(cwd, blobDevTokenNamespace)
})

afterEach(async () => {
  await rm(cwd, { force: true, recursive: true })
  await removeViteHubDevToken(cwd, { namespace: blobDevTokenNamespace, serverId: devToken.serverId })
})

function stream() {
  let value = ""
  const bytes: Uint8Array[] = []
  return {
    bytes: () => bytes,
    output: () => value,
    write(chunk: string | Uint8Array) {
      if (typeof chunk !== "string") bytes.push(chunk)
      else value += chunk
      return true
    },
  }
}

function context() {
  const stdout = stream()
  const stderr = stream()
  return { context: { cwd, env: {}, rootDir: cwd, stderr, stdout }, stderr, stdout }
}

function discovery() {
  return { blobDevTokenServerId: devToken.serverId, root: cwd, runtime: "nitro" }
}

/** Fake dev server: `GET` discovery, then one `POST` operation. */
function devServer(result: unknown, init: { discovery?: Record<string, unknown>, status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? Response.json(result, { status: init.status ?? 200 })
    : Response.json({ ...discovery(), ...init.discovery }))
}

function fileServer(bytes: Uint8Array, header: unknown) {
  return vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
    ? new Response(bytes, { headers: { "content-type": "application/octet-stream", [blobDevFileHeader]: encodeURIComponent(JSON.stringify(header)) } })
    : Response.json(discovery()))
}

function sentBody(fetch: ReturnType<typeof devServer>): unknown {
  return JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))
}

const binary = Uint8Array.from([0, 255, 1, 128, 10, 13, 0xef, 0xbb, 0xbf, 0xc3, 0x28])
const object = { contentType: "image/png", customMetadata: {}, httpEtag: "\"abc\"", httpMetadata: {}, pathname: "images/a.png", size: 1234, uploadedAt: "2026-09-29T10:00:00.000Z" }

describe("vitehub blob", () => {
  it("sends the private token for the discovered dev server", async () => {
    const output = context()
    const fetch = devServer({ blobs: [], hasMore: false, limit: 100, prefix: "", store: "default", stores: ["default"] })
    await expect(runBlobCli(["list"], output.context, { fetch })).resolves.toBe(0)
    const headers = new Headers(fetch.mock.calls[1]?.[1]?.headers)
    expect(headers.get(viteHubDevTokenHeader)).toBe(devToken.token)
    expect(headers.get(blobDevTokenServerHeader)).toBe(devToken.serverId)
  })

  it.each([undefined, "another-server"])("does not send operations without the discovered private token (%s)", async (serverId) => {
    const output = context()
    const fetch = devServer({}, { discovery: { blobDevTokenServerId: serverId } })
    await expect(runBlobCli(["list"], output.context, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("No private Blob Dev token found")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([["head", "--json"], ["list", "--limit", "0", "--json"], ["list", "--timeout", "4294967296", "--json"], ["list", "--timeout", "2147483648", "--json"]])("returns JSON for argument errors: %j", async (...args) => {
    const output = context()
    const fetch = vi.fn()
    await expect(runBlobCli(args, output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: expect.any(String) } })
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["", " "])("rejects an empty output path %j before downloading", async outputPath => {
    const output = context()
    const fetch = vi.fn()
    await expect(runBlobCli(["get", "source.bin", "--output", outputPath], output.context, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("--output needs a nonempty path")
    expect(output.stdout.bytes()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([{ flags: [] }, { flags: ["--json"] }])("reports failed error body reads with flags %j", async ({ flags }) => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("error body interrupted")) } }), { status: 502 })
    const fetch = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST" ? response : Response.json(discovery()))
    const output = context()
    await expect(runBlobCli(["list", ...flags], output.context, { fetch })).resolves.toBe(1)
    if (flags.includes("--json")) {
      expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "Could not read the Blob error response: error body interrupted" } })
      expect(output.stderr.output()).toBe("")
    }
    else expect(output.stderr.output()).toContain("error body interrupted")
  })

  it.each([{ flags: [] }, { flags: ["--json", "--output", "failed.bin"] }])("reports failed download body reads with flags %j", async ({ flags }) => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error("download interrupted")) } }))
    const fetch = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST" ? response : Response.json(discovery()))
    const output = context()
    await expect(runBlobCli(["get", "source.bin", ...flags], output.context, { fetch })).resolves.toBe(1)
    if (flags.includes("--json")) {
      expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "Could not read the Blob download: download interrupted" } })
      expect(output.stderr.output()).toBe("")
      await expect(readFile(join(cwd, "failed.bin"))).rejects.toMatchObject({ code: "ENOENT" })
    }
    else {
      expect(output.stdout.bytes()).toEqual([])
      expect(output.stderr.output()).toContain("download interrupted")
    }
  })

  it.each([{ flags: [] }, { flags: ["--json"] }])("reports malformed blob rows with flags %j", async ({ flags }) => {
    const output = context()
    await expect(runBlobCli(["list", ...flags], output.context, { fetch: devServer({ blobs: [{}], hasMore: false, limit: 100, prefix: "", store: "default", stores: ["default"] }) })).resolves.toBe(1)
    expect(output.stdout.output() + output.stderr.output()).toContain("response is invalid")
  })

  it("lists blobs as a table and as JSON", async () => {
    const result = { blobs: [object, { ...object, contentType: undefined, pathname: "images/b", size: 5 }], cursor: "next", hasMore: true, limit: 2, prefix: "images/", store: "default", stores: ["default", "media"] }
    const human = context()
    const fetch = devServer(result)

    await expect(runBlobCli(["list", "--prefix", "images/", "--limit=2", "--url", "http://127.0.0.1:4321"], human.context, { fetch })).resolves.toBe(0)

    expect(human.stdout.output()).toBe([
      "PATHNAME      SIZE    CONTENT TYPE  UPLOADED",
      "images/a.png  1234 B  image/png     2026-09-29T10:00:00.000Z",
      "images/b      5 B     -             2026-09-29T10:00:00.000Z",
      "",
    ].join("\n"))
    expect(human.stderr.output()).toBe("More blobs exist. Next page: --cursor next\n")
    const [discovery, operation] = fetch.mock.calls
    expect(String(discovery?.[0])).toBe(`http://127.0.0.1:4321${blobDevRoute}`)
    expect(operation?.[1]).toMatchObject({
      headers: { "content-type": "application/json", [blobDevHeader]: blobDevHeaderValue },
      method: "POST",
    })
    expect(JSON.parse(String(operation?.[1]?.body))).toEqual({ limit: 2, operation: "list", prefix: "images/" })

    const json = context()
    const jsonFetch = devServer(result)
    await expect(runBlobCli(["list", "--cursor", "next", "--store", "media", "--json"], json.context, { fetch: jsonFetch })).resolves.toBe(0)
    expect(sentBody(jsonFetch)).toEqual({ cursor: "next", operation: "list", store: "media" })
    expect(JSON.parse(json.stdout.output())).toEqual(JSON.parse(JSON.stringify(result)))

    const empty = context()
    await expect(runBlobCli(["list", "--prefix", "x/"], empty.context, { fetch: devServer({ blobs: [], hasMore: false, limit: 100, prefix: "x/", store: "default", stores: ["default"] }) })).resolves.toBe(0)
    expect(empty.stdout.output()).toBe("No blobs with prefix x/ in store default.\n")
  })

  it("prints blob metadata", async () => {
    const human = context()
    await expect(runBlobCli(["head", "images/a.png"], human.context, { fetch: devServer({ object: { ...object, customMetadata: { owner: "ada", token: "[redacted]" } }, store: "default" }) })).resolves.toBe(0)
    expect(human.stdout.output()).toBe([
      "Pathname         images/a.png",
      "Store            default",
      "Size             1234 B",
      "Content type     image/png",
      "ETag             \"abc\"",
      "Uploaded         2026-09-29T10:00:00.000Z",
      "Custom metadata  owner=ada, token=[redacted]",
      "",
    ].join("\n"))

    const json = context()
    const fetch = devServer({ object, store: "media" })
    await expect(runBlobCli(["head", "images/a.png", "--store", "media", "--json"], json.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toEqual({ operation: "head", pathname: "images/a.png", store: "media" })
    expect(JSON.parse(json.stdout.output())).toEqual({ object, store: "media" })
  })

  it("writes downloaded bytes unchanged to stdout or to a file", async () => {
    const header = { contentType: "application/octet-stream", pathname: "raw.bin", size: binary.byteLength, store: "default" }
    const piped = context()
    const fetch = fileServer(binary, header)
    await expect(runBlobCli(["get", "raw.bin"], piped.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toEqual({ operation: "get", pathname: "raw.bin" })
    expect(piped.stdout.bytes().map(chunk => new Uint8Array(chunk))).toEqual([binary])
    expect(piped.stdout.output()).toBe("")

    const saved = context()
    await expect(runBlobCli(["get", "raw.bin", "--output", "out/../raw.bin"], saved.context, { fetch: fileServer(binary, header) })).resolves.toBe(0)
    expect(new Uint8Array(await readFile(join(cwd, "raw.bin")))).toEqual(binary)
    expect(saved.stdout.output()).toBe(`Wrote blob raw.bin from store default to ${join(cwd, "raw.bin")} (${binary.byteLength} B).\n`)

    const json = context()
    await expect(runBlobCli(["get", "raw.bin", "--output=copy.bin", "--json"], json.context, { fetch: fileServer(binary, header) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual({ ...header, output: join(cwd, "copy.bin") })
  })

  it("writes a download before the response finishes and waits for stdout backpressure", async () => {
    let finishResponse: (() => void) | undefined
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(binary)
        finishResponse = () => {
          controller.enqueue(binary)
          controller.close()
        }
      },
    }))
    const bufferedRead = vi.spyOn(response, "arrayBuffer")
    let releaseWrite: (() => void) | undefined
    const chunks: Uint8Array[] = []
    let firstWrite: (() => void) | undefined
    const started = new Promise<void>((resolve) => { firstWrite = resolve })
    const stdout = new Writable({
      highWaterMark: 1,
      write(chunk: Uint8Array, _encoding, callback) {
        chunks.push(new Uint8Array(chunk))
        if (chunks.length === 1) {
          releaseWrite = callback
          firstWrite!()
        }
        else callback()
      },
    })
    const output = context()
    const fetch = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST" ? response : Response.json(discovery()))
    let finished = false
    const result = runBlobCli(["get", "raw.bin"], { ...output.context, stdout }, { fetch }).then((code) => {
      finished = true
      return code
    })
    await started
    finishResponse!()
    await new Promise(resolve => setImmediate(resolve))
    expect(chunks).toEqual([binary])
    expect(finished).toBe(false)
    releaseWrite!()
    await expect(result).resolves.toBe(0)
    expect(chunks).toEqual([binary, binary])
    expect(bufferedRead).not.toHaveBeenCalled()
    expect(stdout.writableEnded).toBe(false)
    stdout.end()
  })

  it("cancels a stalled download when stdout fails", async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(binary) },
      cancel,
    }))
    const stdout = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error("broken pipe")) },
    })
    const output = context()
    const fetch = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST" ? response : Response.json(discovery()))
    await expect(runBlobCli(["get", "raw.bin"], { ...output.context, stdout }, { fetch })).resolves.toBe(1)
    expect(output.stderr.output()).toContain("broken pipe")
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("preserves an existing output file and removes temporary data after a partial download fails", async () => {
    await writeFile(join(cwd, "saved.bin"), "existing data")
    let pullCount = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount++ === 0) controller.enqueue(binary)
        else controller.error(new Error("download interrupted"))
      },
    }))
    const output = context()
    const fetch = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST" ? response : Response.json(discovery()))
    await expect(runBlobCli(["get", "raw.bin", "--output", "saved.bin", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: "Could not read the Blob download: download interrupted" } })
    expect(await readFile(join(cwd, "saved.bin"), "utf8")).toBe("existing data")
    expect((await readdir(cwd)).filter(name => name.endsWith(".tmp"))).toEqual([])
  })

  it("uploads a file as base64 and prints what changed", async () => {
    await writeFile(join(cwd, "raw.bin"), binary)
    const created = context()
    const fetch = devServer({ created: true, object: { ...object, contentType: "application/x-test", pathname: "files/raw.bin", size: binary.byteLength }, store: "default" })
    await expect(runBlobCli(["put", "files/raw.bin", "raw.bin", "--content-type", "application/x-test"], created.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toEqual({ contentType: "application/x-test", data: Buffer.from(binary).toString("base64"), operation: "put", pathname: "files/raw.bin" })
    expect(Buffer.from(String(Reflect.get(sentBody(fetch) as object, "data")), "base64")).toEqual(Buffer.from(binary))
    expect(created.stdout.output()).toBe(`Created blob files/raw.bin in store default (${binary.byteLength} B, application/x-test).\n`)

    const replaced = context()
    await expect(runBlobCli(["put", "files/raw.bin", "raw.bin", "--store", "media"], replaced.context, { fetch: devServer({ created: false, object: { ...object, pathname: "files/raw.bin", size: 11 }, store: "media" }) })).resolves.toBe(0)
    expect(replaced.stdout.output()).toBe("Replaced blob files/raw.bin in store media (11 B, image/png).\n")
  })

  it("prints what del changed", async () => {
    const deleted = context()
    await expect(runBlobCli(["del", "a.txt"], deleted.context, { fetch: devServer({ deleted: true, pathname: "a.txt", store: "default" }) })).resolves.toBe(0)
    expect(deleted.stdout.output()).toBe("Deleted blob a.txt from store default.\n")

    const unchanged = context()
    await expect(runBlobCli(["del", "a.txt"], unchanged.context, { fetch: devServer({ deleted: false, pathname: "a.txt", store: "default" }) })).resolves.toBe(0)
    expect(unchanged.stdout.output()).toBe("Blob a.txt did not exist in store default. Nothing changed.\n")

    const json = context()
    await expect(runBlobCli(["del", "a.txt", "--json"], json.context, { fetch: devServer({ deleted: true, pathname: "a.txt", store: "default" }) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual({ deleted: true, pathname: "a.txt", store: "default" })
  })

  it("rejects files over the upload limit before it calls the server", async () => {
    await writeFile(join(cwd, "large.bin"), "")
    await truncate(join(cwd, "large.bin"), blobDevMaximumUploadBytes + 1)
    const fetch = vi.fn()
    const json = context()
    await expect(runBlobCli(["put", "large.bin", "large.bin", "--json"], json.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toMatchObject({ error: { code: "BLOB_DEV_UPLOAD_TOO_LARGE" } })

    const missing = context()
    await expect(runBlobCli(["put", "a.txt", "missing.txt"], missing.context, { fetch })).resolves.toBe(1)
    expect(missing.stderr.output()).toBe(`File not found: ${join(cwd, "missing.txt")}\n`)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reports runtime errors on stderr, or as JSON with --json", async () => {
    const failure = { error: { code: "BLOB_NOT_FOUND", message: "Blob a.txt was not found in store default." } }
    const human = context()
    await expect(runBlobCli(["get", "a.txt"], human.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(human.stdout.bytes()).toEqual([])
    expect(human.stderr.output()).toBe("Blob a.txt was not found in store default.\n")

    const json = context()
    await expect(runBlobCli(["head", "a.txt", "--json"], json.context, { fetch: devServer(failure, { status: 404 }) })).resolves.toBe(1)
    expect(JSON.parse(json.stdout.output())).toEqual(failure)

    const guard = context()
    await expect(runBlobCli(["list"], guard.context, {
      fetch: vi.fn(async (_url: string | URL | Request, request?: RequestInit) => request?.method === "POST"
        ? new Response("Forbidden Blob Dev request.", { status: 403 })
        : Response.json(discovery())),
    })).resolves.toBe(1)
    expect(guard.stderr.output()).toBe("Forbidden Blob Dev request.\n")
  })

  it("explains hosts that cannot reach the Blob runtime", async () => {
    const unavailable = context()
    const fetch = devServer({}, { discovery: { message: blobDevRuntimeUnavailableMessage, root: cwd, runtime: "unavailable" } })
    await expect(runBlobCli(["list", "--json"], unavailable.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(unavailable.stdout.output())).toEqual({
      error: { code: "BLOB_DEV_RUNTIME_UNAVAILABLE", message: blobDevRuntimeUnavailableMessage },
    })

    const missing = context()
    await expect(runBlobCli(["list"], missing.context, { fetch: vi.fn(async () => new Response("Not found", { status: 404 })) })).resolves.toBe(1)
    expect(missing.stderr.output()).toBe([
      "No Compatible Vite Development Server found at http://localhost:5173.",
      "`vitehub blob` needs a running Vite + Nitro Development Server with `blob` enabled. Nuxt and plain Vite are not supported.",
      "",
    ].join("\n"))
  })

  it("reports upload read errors as JSON failures", async () => {
    await writeFile(join(cwd, "unreadable.bin"), binary)
    vi.mocked(readFile).mockRejectedValueOnce(new Error("read denied"))
    const output = context()
    const fetch = vi.fn()
    await expect(runBlobCli(["put", "target.bin", "unreadable.bin", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toEqual({ error: { message: `Could not read ${join(cwd, "unreadable.bin")}: read denied` } })
    expect(output.stderr.output()).toBe("")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reports discovery failures as JSON without stderr diagnostics", async () => {
    for (const fetch of [vi.fn(async () => { throw new Error("offline") }), devServer({}, { discovery: { root: "/other" } })]) {
      const output = context()
      await expect(runBlobCli(["list", "--json"], output.context, { fetch })).resolves.toBe(1)
      expect(JSON.parse(output.stdout.output())).toMatchObject({ error: { message: expect.stringContaining("Compatible Vite Development Server") } })
      expect(output.stderr.output()).toBe("")
      expect(fetch).toHaveBeenCalledOnce()
    }
  })

  it("times out discovery before sending an operation", async () => {
    const output = context()
    const fetch = vi.fn((_url: string | URL | Request, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
    }))
    await expect(runBlobCli(["list", "--json", "--timeout", "10"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(output.stderr.output()).toBe("")
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it("validates arguments before it calls the server", async () => {
    const fetch = vi.fn()
    const cases: Array<[string[], string]> = [
      [["head"], "Missing pathname."],
      [["put", "a.txt"], "Missing file."],
      [["put", "a.txt", "a.txt", "b.txt"], "Unexpected argument: b.txt."],
      [["get", "a.txt", "--json"], "--json needs --output"],
      [["list", "--limit", "0"], "--limit must be a positive integer."],
      [["list", "--limit", "500"], "--limit must be at most 250."],
      [["list", "--output", "x"], "Unknown option: --output."],
      [["head", "a.txt", "--prefix", "x"], "Unknown option: --prefix."],
      [["list", "--store"], "--store needs a value."],
      [["del", "a.txt", "--store", ""], "--store needs a nonempty name."],
      [["del", "a.txt", "--store="], "--store needs a nonempty name."],
    ]
    for (const [args, message] of cases) {
      const invalid = context()
      await expect(runBlobCli(args, invalid.context, { fetch })).resolves.toBe(1)
      if (args.includes("--json")) {
        expect(JSON.parse(invalid.stdout.output()).error.message).toContain(message)
        expect(invalid.stderr.output()).toBe("")
      }
      else {
        expect(invalid.stderr.output(), args.join(" ")).toContain(message)
        expect(invalid.stderr.output()).toContain("Usage: vitehub blob")
      }
    }
    const unknown = context()
    await expect(runBlobCli(["sign"], unknown.context, { fetch })).resolves.toBe(1)
    expect(unknown.stderr.output()).toBe("Unknown blob command: sign\nCommands: list, head, get, put, del\n")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("contributes one feature per command", () => {
    const [namespace] = createBlobCliNamespaces()
    expect(namespace?.name).toBe("blob")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["list", "head", "get", "put", "del"])
    expect(namespace?.features.find(feature => feature.name === "put")?.usage).toBe(
      "vitehub blob put <pathname> <file> [--content-type <type>] [--store <name>] [--json] [--url <url>]",
    )
  })
})

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

function fakeServer(environments?: Record<string, unknown>) {
  const middlewares: Middleware[] = []
  const server: BlobDevServer = {
    config: { root: "/app", server: { port: 5173 } },
    environments,
    middlewares: { use: handler => middlewares.push(handler) },
  }
  return { middlewares, server }
}

async function call(middleware: Middleware, init: { body?: string, headers?: Record<string, string>, method: string }) {
  const req = Object.assign(Readable.from(init.body ? [Buffer.from(init.body)] : []), {
    headers: { host: "localhost:5173", ...init.headers },
    method: init.method,
    url: blobDevRoute,
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
  return { body: Buffer.concat(chunks), headers, status: res.statusCode }
}

const guard = { [blobDevHeader]: blobDevHeaderValue }

describe("Blob dev endpoint", () => {
  it("uses the project token for CLI requests from a nested Vite root", async () => {
    await writeFile(join(cwd, "package.json"), "{}")
    const nestedRoot = join(cwd, "nested", "app")
    await mkdir(nestedRoot, { recursive: true })
    const dispatchFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get(viteHubDevTokenHeader)).toBe(devToken.token)
      expect(request.headers.get(blobDevTokenServerHeader)).toBe(devToken.serverId)
      expect(await request.json()).toEqual({ operation: "list" })
      return Response.json({ blobs: [], hasMore: false, limit: 100, prefix: "", store: "default", stores: ["default"] })
    })
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    server.config.root = nestedRoot
    registerBlobDevEndpoint(server, {
      devTokenServerId: () => devToken.serverId,
      discovery: () => ({ blobDevTokenServerId: devToken.serverId }),
      forwardHeaders: [viteHubDevTokenHeader, blobDevTokenServerHeader],
    })
    const fetch = vi.fn(async (_url: string | URL | Request, request?: RequestInit) => {
      const response = await call(middlewares[0]!, {
        body: typeof request?.body === "string" ? request.body : undefined,
        headers: Object.fromEntries(new Headers(request?.headers)),
        method: request?.method ?? "GET",
      })
      return new Response(response.body, { headers: response.headers, status: response.status })
    })
    const output = context()
    output.context.cwd = nestedRoot
    output.context.rootDir = nestedRoot
    await expect(runBlobCli(["list", "--json"], output.context, { fetch })).resolves.toBe(0)
    expect(JSON.parse(output.stdout.output())).toMatchObject({ blobs: [], store: "default" })
    expect(dispatchFetch).toHaveBeenCalledOnce()

    expect(await call(middlewares[0]!, {
      body: "{\"operation\":\"list\"}",
      headers: { ...guard, "content-type": "application/json", [viteHubDevTokenHeader]: "wrong-token", [blobDevTokenServerHeader]: devToken.serverId },
      method: "POST",
    })).toMatchObject({ status: 403 })
    expect(dispatchFetch).toHaveBeenCalledOnce()
  })

  it("rejects a nested Vite root from an independent project", async () => {
    await writeFile(join(cwd, "package.json"), "{}")
    const nestedRoot = join(cwd, "nested", "app")
    await mkdir(join(nestedRoot, "server", "blobs"), { recursive: true })
    await writeFile(join(nestedRoot, "package.json"), "{}")
    const fetch = devServer({}, { discovery: { root: nestedRoot } })
    const output = context()
    output.context.cwd = nestedRoot
    output.context.rootDir = cwd
    await expect(runBlobCli(["list", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("rejects requests without the guard header or from another origin", async () => {
    const { middlewares, server } = fakeServer()
    registerBlobDevEndpoint(server)

    expect(await call(middlewares[0]!, { method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { headers: { ...guard, origin: "https://attacker.test" }, method: "GET" })).toMatchObject({ status: 403 })
    expect(await call(middlewares[0]!, { body: "{}", headers: { ...guard, "content-type": "text/plain" }, method: "POST" })).toMatchObject({ status: 415 })
    expect(await call(middlewares[0]!, { headers: guard, method: "DELETE" })).toMatchObject({ status: 405 })
  })

  it("returns 501 on hosts without an in-process Nitro environment", async () => {
    const { middlewares, server } = fakeServer()
    registerBlobDevEndpoint(server)

    const discovery = await call(middlewares[0]!, { headers: guard, method: "GET" })
    expect(JSON.parse(discovery.body.toString("utf8"))).toEqual({ message: blobDevRuntimeUnavailableMessage, root: "/app", runtime: "unavailable" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"list\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })
    expect(operation.status).toBe(501)
    expect(JSON.parse(operation.body.toString("utf8"))).toMatchObject({ error: { code: "BLOB_DEV_RUNTIME_UNAVAILABLE" } })
  })

  it("forwards operations into the Nitro environment and keeps binary responses unchanged", async () => {
    const dispatchFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe(`http://localhost/app${blobDevRuntimeRoute}`)
      expect(request.headers.get(blobDevHeader)).toBe(blobDevHeaderValue)
      expect(await request.text()).toBe("{\"operation\":\"get\",\"pathname\":\"raw.bin\"}")
      return new Response(binary, { headers: { "content-type": "application/octet-stream", [blobDevFileHeader]: "x" } })
    })
    const { middlewares, server } = fakeServer({ nitro: { dispatchFetch } })
    registerBlobDevEndpoint(server, { nitroBaseURL: () => "/app/" })

    expect(JSON.parse((await call(middlewares[0]!, { headers: guard, method: "GET" })).body.toString("utf8"))).toEqual({ root: "/app", runtime: "nitro" })
    const operation = await call(middlewares[0]!, { body: "{\"operation\":\"get\",\"pathname\":\"raw.bin\"}", headers: { ...guard, "content-type": "application/json" }, method: "POST" })

    expect(operation.status).toBe(200)
    expect(new Uint8Array(operation.body)).toEqual(binary)
    expect(operation.headers[blobDevFileHeader]).toBe("x")
    expect(dispatchFetch).toHaveBeenCalledOnce()
  })
})

describe("hubBlob dev handler", () => {
  type ConfigResolvedHook = (config: Record<string, unknown>) => Promise<void>

  it("adds and writes the Nitro route only in serve mode", async () => {
    const configResolved = (importBase?: string): ConfigResolvedHook => {
      const plugin = hubBlob({ base: ".data/blob", driver: "fs" }, importBase ? { importBase } : {})
      // SAFETY: The test calls the concrete hook with the Vite config fields that it reads.
      return plugin.configResolved as unknown as ConfigResolvedHook
    }
    const handler = join(cwd, ".vitehub/nitro/blob/dev-handler.ts")

    const build: Record<string, unknown> = { build: { outDir: "dist" }, command: "build", nitro: {}, root: cwd }
    await configResolved()(build)
    expect(build.nitro).toMatchObject({ handlers: [] })
    await expect(readFile(handler, "utf8")).rejects.toMatchObject({ code: "ENOENT" })

    const serve: Record<string, unknown> = { build: { outDir: "dist" }, command: "serve", nitro: { baseURL: "/app/" }, root: cwd }
    await configResolved("vite-hub/_internal/blob")(serve)
    expect(serve.nitro).toMatchObject({ baseURL: "/app/", handlers: [{ handler, route: blobDevRuntimeRoute }] })
    expect(await readFile(handler, "utf8")).toContain("import { handleBlobDevRequest as handleViteHubDevRequest } from \"vite-hub/_internal/blob/runtime/dev\"")
  })

  it("contributes the blob CLI namespace and keeps the provision steps", async () => {
    const contributor = await hubBlob().vitehub?.cli?.()
    expect(contributor?.namespaces?.map(namespace => namespace.name)).toEqual(["blob"])
    expect(contributor?.provision).toHaveLength(2)
  })
})
