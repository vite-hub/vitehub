import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createBlobCliNamespaces, runBlobCli } from "../src/cli.ts"
import { blobDevMaximumUploadBytes } from "../src/results.ts"
import { hubBlob } from "../src/vite.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "vitehub-blob-cli-"))
})

afterEach(async () => {
  await rm(cwd, { force: true, recursive: true })
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
  return { context: { cwd, env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" } as NodeJS.ProcessEnv, rootDir: cwd, stderr, stdout }, stderr, stdout }
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
    return Response.json({ ok: false, code: error.code ?? "BLOB_FAILED", message: error.message, status }, { status })
  })
}

/** A fake app that returns one file, as `blob.get` does. */
function fileServer(bytes: Uint8Array, header: { contentType?: string, pathname: string, size: number, store: string }) {
  return devServer({ ...header, data: Buffer.from(bytes).toString("base64") })
}

/** The operation and input that a command sent, with the operation name as `operation`. */
function sentBody(fetch: ReturnType<typeof devServer>): Record<string, unknown> {
  const { input, operation } = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { input: Record<string, unknown>, operation: string }
  return { ...input, operation: operation.replace(/^blob\./, "") }
}

const binary = Uint8Array.from([0, 255, 1, 128, 10, 13, 0xef, 0xbb, 0xbf, 0xc3, 0x28])
const object = { contentType: "image/png", customMetadata: {}, httpEtag: "\"abc\"", httpMetadata: {}, pathname: "images/a.png", size: 1234, uploadedAt: "2026-09-29T10:00:00.000Z" }

describe("vitehub blob", () => {
  it("sends the operation to the dev server of the project", async () => {
    const output = context()
    const fetch = devServer({ blobs: [], hasMore: false, limit: 100, prefix: "", store: "default", stores: ["default"] })
    await expect(runBlobCli(["list"], output.context, { fetch })).resolves.toBe(0)
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://localhost:5173/_vitehub/rpc/__call")
    expect(sentBody(fetch)).toEqual({ operation: "list", showVitehub: true })
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-vitehub-console")).toBe("1")
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

  it.each([{ flags: [] }, { flags: ["--json"] }])("reports malformed blob rows with flags %j", async ({ flags }) => {
    const output = context()
    await expect(runBlobCli(["list", ...flags], output.context, { fetch: devServer({ blobs: [{}], hasMore: false, limit: 100, prefix: "", store: "default", stores: ["default"] }) })).resolves.toBe(1)
    expect(output.stdout.output() + output.stderr.output()).toContain("answered with an invalid result")
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
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4321/_vitehub/rpc/__call")
    expect(sentBody(fetch)).toEqual({ limit: 2, operation: "list", prefix: "images/", showVitehub: true })

    const json = context()
    const jsonFetch = devServer(result)
    await expect(runBlobCli(["list", "--cursor", "next", "--store", "media", "--json"], json.context, { fetch: jsonFetch })).resolves.toBe(0)
    expect(sentBody(jsonFetch)).toEqual({ cursor: "next", operation: "list", showVitehub: true, store: "media" })
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

  it("preserves an existing output file when the destination cannot be written", async () => {
    await writeFile(join(cwd, "saved.bin"), "existing data")
    const output = context()
    const fetch = fileServer(binary, { pathname: "raw.bin", size: binary.byteLength, store: "default" })
    await expect(runBlobCli(["get", "raw.bin", "--output", "missing-folder/saved.bin", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toMatchObject({ error: { message: expect.stringContaining("Could not write") } })
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
    expect(JSON.parse(json.stdout.output())).toMatchObject({ error: { code: "BLOB_UPLOAD_TOO_LARGE" } })

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

    const forbidden = context()
    await expect(runBlobCli(["list"], forbidden.context, {
      fetch: vi.fn(async () => Response.json({ ok: false, code: "INTERNAL_R0023", message: "No access to the blob section.", status: 403 }, { status: 403 })),
    })).resolves.toBe(1)
    expect(forbidden.stderr.output()).toContain("No access to the blob section.")
  })

  it("says to start the dev server when none runs for the project", async () => {
    const missing = context()
    missing.context.env = {}
    await expect(runBlobCli(["list"], missing.context, { fetch: vi.fn() })).resolves.toBe(1)
    expect(missing.stderr.output()).toContain(`No dev server is running for ${cwd}.`)
    expect(missing.stderr.output()).toContain("vite dev")
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

  it("reports an app that cannot be reached as JSON without stderr diagnostics", async () => {
    const output = context()
    const fetch = vi.fn(async () => { throw new Error("offline") })
    await expect(runBlobCli(["list", "--json"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toMatchObject({ error: { code: "INTERNAL_R0024", message: expect.stringContaining("offline") } })
    expect(output.stderr.output()).toBe("")
  })

  it("applies the request timeout", async () => {
    const output = context()
    const fetch = vi.fn((_url: string | URL | Request, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true })
    }))
    await expect(runBlobCli(["list", "--json", "--timeout", "10"], output.context, { fetch })).resolves.toBe(1)
    expect(JSON.parse(output.stdout.output())).toHaveProperty("error.message")
    expect(fetch).toHaveBeenCalledOnce()
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
    expect(unknown.stderr.output()).toBe("Unknown blob command: sign\nCommands: list, head, get, put, del, media, variants\n")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("prints media records and cached variants", async () => {
    const record = {
      alt: "Hero", color: "#336699", contentType: "image/png", createdAt: "2026-10-01T00:00:00.000Z",
      crops: { mobile: { aspect: "4:5", focal: { x: 0.5, y: 0.2 }, replacement: { contentType: "image/png", hash: "f".repeat(64), height: 500, pathname: "_vitehub/media/crops/abc/mobile.ffffffffffff.png", size: 10, width: 400 } }, square: { aspect: "1:1" } },
      focal: { x: 0.25, y: 0.75 }, hash: "a".repeat(64), height: 300, pathname: "images/hero.png", size: 2048, updatedAt: "2026-10-02T00:00:00.000Z", url: "/api/_vitehub/blob/images/hero.png", width: 600,
    }
    const human = context()
    const fetch = devServer({ record, store: "default" })
    await expect(runBlobCli(["media", "images/hero.png"], human.context, { fetch })).resolves.toBe(0)
    expect(sentBody(fetch)).toEqual({ operation: "media", pathname: "images/hero.png" })
    expect(human.stdout.output()).toBe([
      "Pathname      images/hero.png",
      "Store         default",
      "Size          2048 B",
      "Content type  image/png",
      "Dimensions    600x300",
      `SHA-256       ${"a".repeat(64)}`,
      "Alt           Hero",
      "Focal point   0.25,0.75",
      "Color         #336699",
      "URL           /api/_vitehub/blob/images/hero.png",
      "Updated       2026-10-02T00:00:00.000Z",
      "Crops         mobile 4:5, focal 0.5,0.2, replacement _vitehub/media/crops/abc/mobile.ffffffffffff.png (400x500)",
      "              square 1:1",
      "",
    ].join("\n"))
    const json = context()
    await expect(runBlobCli(["media", "images/hero.png", "--json"], json.context, { fetch: devServer({ record, store: "default" }) })).resolves.toBe(0)
    expect(JSON.parse(json.stdout.output())).toEqual({ record, store: "default" })

    const variants = context()
    const variant = { cachePathname: "_vitehub/derived/x/y", contentType: "image/webp", key: "image:v1;src=original;out=640x320;fmt=webp;q=75;engine=sharp", size: 4096, source: "images/hero.png" }
    await expect(runBlobCli(["variants", "images/hero.png"], variants.context, { fetch: devServer({ pathname: "images/hero.png", store: "default", variants: [variant] }) })).resolves.toBe(0)
    expect(variants.stdout.output()).toBe([
      "KEY                                                           TYPE        SIZE    SOURCE",
      "image:v1;src=original;out=640x320;fmt=webp;q=75;engine=sharp  image/webp  4096 B  images/hero.png",
      "",
    ].join("\n"))
    const none = context()
    await expect(runBlobCli(["variants", "images/hero.png"], none.context, { fetch: devServer({ pathname: "images/hero.png", store: "default", variants: [] }) })).resolves.toBe(0)
    expect(none.stdout.output()).toBe("No cached variants of images/hero.png in store default.\n")
  })

  it("contributes one feature per command", () => {
    const [namespace] = createBlobCliNamespaces()
    expect(namespace?.name).toBe("blob")
    expect(namespace?.features.map(feature => feature.name)).toEqual(["list", "head", "get", "put", "del", "media", "variants"])
    expect(namespace?.features.find(feature => feature.name === "put")?.usage).toBe(
      "vitehub blob put <pathname> <file> [--content-type <type>] [--store <name>] [--json] [--url <url>]",
    )
  })
})

describe("hubBlob", () => {
  it("contributes the blob operations and the CLI namespace with the provision steps, and no dev route", async () => {
    const plugin = hubBlob()
    const contributor = await plugin.vitehub?.cli?.()
    expect(contributor?.namespaces?.map(namespace => namespace.name)).toEqual(["blob"])
    expect(contributor?.provision).toHaveLength(2)
    expect(plugin.vitehub.operations).toEqual([expect.objectContaining({ export: "blobOperations", module: "@vite-hub/blob/operations" })])
    const operations = await plugin.vitehub.operations[0]!.load!() as Array<{ name: string }>
    expect(operations.map(operation => operation.name)).toEqual(["blob.list", "blob.head", "blob.get", "blob.put", "blob.del", "blob.media", "blob.variants"])
  })

  it("registers no Nitro route for the commands, in serve or in build mode", async () => {
    const plugin = hubBlob({ base: ".data/blob", driver: "fs" })
    for (const command of ["build", "serve"]) {
      const config: Record<string, unknown> = { build: { outDir: "dist" }, command, nitro: {}, root: cwd }
      await (plugin.configResolved as unknown as (config: Record<string, unknown>) => Promise<void>)(config)
      expect(JSON.stringify(config.nitro)).not.toContain("dev-handler")
      expect(JSON.stringify(config.nitro)).not.toContain("/_vitehub/blob/dev")
    }
  })
})
