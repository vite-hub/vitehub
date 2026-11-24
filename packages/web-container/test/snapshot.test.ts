import { createHash, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { bootWebContainer, fetchSnapshot } from "../src/index.ts"
import { snapshotLinksFile } from "../src/links.ts"
import { createNodeModulesSnapshot, packSnapshot } from "../src/snapshot.ts"

const api = vi.hoisted(() => ({ boot: vi.fn() }))
vi.mock("@webcontainer/api", () => ({ WebContainer: api }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function container(listed: boolean) {
  const events = new EventEmitter()
  const written = new Map<string, string>()
  const value = {
    fs: {
      readFile: vi.fn(async (path: string) => {
        if (listed && path === `node_modules/${snapshotLinksFile}`) return "{\"links\":[],\"executables\":[]}"
        throw new Error("ENOENT")
      }),
      writeFile: vi.fn(async (path: string, contents: string) => { written.set(path, contents) }),
    },
    mount: vi.fn(async () => {}),
    spawn: vi.fn(async () => ({ output: new ReadableStream(), input: new WritableStream(), exit: Promise.resolve(0), kill: vi.fn() })),
    teardown: vi.fn(),
    on: events.on.bind(events),
  }
  api.boot.mockResolvedValue(value)
  return { container: value, written }
}

beforeEach(() => {
  vi.stubGlobal("document", {})
  vi.stubGlobal("crossOriginIsolated", true)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("snapshots", () => {
  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid part size of %s", (partBytes) => {
    expect(() => packSnapshot(new Uint8Array([1]), { partBytes })).toThrow(expect.objectContaining({ code: "WEB_CONTAINER_SNAPSHOT_PART_BYTES_INVALID" }))
  })

  it("rejects Windows before changing the dependency tree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snapshot-host-"))
    try {
      await mkdir(join(dir, "node_modules"))
      await writeFile(join(dir, "node_modules/keep.txt"), "installed dependencies")
      await writeFile(join(dir, "package.json"), '{"private":true}')
      vi.stubGlobal("process", { ...process, platform: "win32" })
      await expect(createNodeModulesSnapshot({ dir })).rejects.toThrow("requires a POSIX host")
      expect(await readFile(join(dir, "node_modules/keep.txt"), "utf8")).toBe("installed dependencies")
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("packs a snapshot into parts that fetchSnapshot joins and inflates", async () => {
    const data = new Uint8Array(randomBytes(300_000))
    const parts = packSnapshot(data, { partBytes: 50_000 })
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(part => part.byteLength <= 50_000)).toBe(true)
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const index = Number(url.split("/").at(-1))
      await new Promise(resolve => setTimeout(resolve, (parts.length - index) * 5))
      return new Response(parts[index])
    }))
    const joined = await fetchSnapshot(parts.map((_, index) => `/parts/${index}`))
    expect(joined).toEqual(data)
  })

  it("keeps parts in Cache Storage, so a later load downloads nothing, and drops parts of other URLs", async () => {
    const stored = new Map<string, Response>([["https://docs.test/old.0.bin", new Response("old")]])
    const cache = {
      match: async (url: string) => stored.get(url)?.clone(),
      put: async (url: string, response: Response) => { stored.set(url, response) },
      keys: async () => [...stored.keys()].map(url => new Request(url)),
      delete: async (request: Request) => stored.delete(request.url),
    }
    vi.stubGlobal("caches", { open: async () => cache })
    const data = new Uint8Array(randomBytes(1000))
    const [part] = packSnapshot(data)
    const fetchPart = vi.fn(async () => new Response(part))
    vi.stubGlobal("fetch", fetchPart)
    const urls = ["https://docs.test/new.0.bin"]
    expect(await fetchSnapshot(urls, { cache: "app" })).toEqual(data)
    expect(await fetchSnapshot(urls, { cache: "app" })).toEqual(data)
    expect(fetchPart).toHaveBeenCalledOnce()
    expect([...stored.keys()]).toEqual(urls)
  })

  function memoryCache(entries: [string, Response][] = []) {
    const stored = new Map<string, Response>(entries)
    vi.stubGlobal("caches", { open: async () => ({
      match: async (url: string) => stored.get(new Request(url).url)?.clone(),
      put: async (url: string, response: Response) => { stored.set(new Request(url).url, response) },
      keys: async () => [...stored.keys()].map(url => new Request(url)),
      delete: async (request: Request) => stored.delete(request.url),
    }) })
    return stored
  }

  it.each([
    ["an HTML fallback page", () => new TextEncoder().encode("<!doctype html><title>Not found</title>")],
    ["a part cut short", (part: Uint8Array) => part.subarray(0, part.byteLength - 10)],
  ])("caches nothing when a part is %s", async (_, damage) => {
    const stored = memoryCache()
    const [part] = packSnapshot(new Uint8Array(randomBytes(1000)))
    vi.stubGlobal("fetch", vi.fn(async () => new Response(damage(part!))))
    await expect(fetchSnapshot(["https://docs.test/a.0.bin"], { cache: "app" })).rejects.toThrow("is damaged")
    expect(stored.size).toBe(0)
  })

  it("drops a damaged cached part and downloads it again next time", async () => {
    const data = new Uint8Array(randomBytes(1000))
    const [part] = packSnapshot(data)
    const stored = memoryCache([["https://docs.test/a.0.bin", new Response("<!doctype html>")]])
    const fetchPart = vi.fn(async () => new Response(part))
    vi.stubGlobal("fetch", fetchPart)
    await expect(fetchSnapshot(["https://docs.test/a.0.bin"], { cache: "app" })).rejects.toThrow("is damaged")
    expect(stored.size).toBe(0)
    expect(await fetchSnapshot(["https://docs.test/a.0.bin"], { cache: "app" })).toEqual(data)
    expect(fetchPart).toHaveBeenCalledOnce()
    expect(stored.size).toBe(1)
  })

  it("rejects parts whose SHA-256 differs, even when they inflate", async () => {
    const stored = memoryCache()
    const parts = packSnapshot(new Uint8Array(randomBytes(1000)))
    const sha256 = createHash("sha256").update(parts[0]!).digest("hex")
    const other = packSnapshot(new Uint8Array(randomBytes(1000)))
    vi.stubGlobal("fetch", vi.fn(async () => new Response(other[0])))
    const damaged = await fetchSnapshot(["https://docs.test/a.0.bin"], { cache: "app", sha256 }).catch((error: unknown) => error)
    expect(damaged).toMatchObject({ code: "WEB_CONTAINER_SNAPSHOT_DAMAGED", cause: undefined, message: expect.stringContaining(`not ${sha256}`) })
    expect(stored.size).toBe(0)
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parts[0])))
    await expect(fetchSnapshot(["https://docs.test/a.0.bin"], { cache: "app", sha256 })).resolves.toBeInstanceOf(Uint8Array)
    expect(stored.size).toBe(1)
  })

  it.each([
    ["the server fails", (_part: Uint8Array) => new Response(null, { status: 503 })],
    ["the download is damaged", (part: Uint8Array) => new Response(part.subarray(0, part.byteLength - 10))],
  ])("keeps the cached version that works when %s for a new version", async (_, serve) => {
    const data = new Uint8Array(randomBytes(1000))
    const [oldPart] = packSnapshot(data)
    const [newPart] = packSnapshot(new Uint8Array(randomBytes(1000)))
    const stored = memoryCache([["https://docs.test/old.0.bin", new Response(oldPart)]])
    const fetchPart = vi.fn(async () => serve(newPart!))
    vi.stubGlobal("fetch", fetchPart)
    await expect(fetchSnapshot(["https://docs.test/new.0.bin"], { cache: "app" })).rejects.toMatchObject({ code: expect.stringMatching(/^WEB_CONTAINER_SNAPSHOT_(PART_FAILED|DAMAGED)$/) })
    expect([...stored.keys()]).toEqual(["https://docs.test/old.0.bin"])
    expect(await fetchSnapshot(["https://docs.test/old.0.bin"], { cache: "app" })).toEqual(data)
    expect(fetchPart).toHaveBeenCalledOnce()
  })

  it.each([false, true])("keeps a concurrent successful load after a damaged download (partial cache: %s)", async (partialCache) => {
    const data = new Uint8Array(randomBytes(1000))
    const [packed] = packSnapshot(data)
    const prefix = packed!.subarray(0, 50)
    const suffix = packed!.subarray(50)
    const firstUrl = "https://docs.test/a.0.bin"
    const secondUrl = "https://docs.test/a.1.bin"
    const urls = [firstUrl, secondUrl]
    memoryCache(partialCache ? [[firstUrl, new Response(prefix)]] : [])
    const { promise: downloading, resolve: started } = deferred<void>()
    const { promise: damaged, resolve: finishDamaged } = deferred<Response>()
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === firstUrl) return new Response(prefix)
      started()
      return damaged
    }))
    const options = { cache: "app", sha256: createHash("sha256").update(packed!).digest("hex") }
    const failed = expect(fetchSnapshot(urls, options)).rejects.toMatchObject({ code: "WEB_CONTAINER_SNAPSHOT_DAMAGED" })
    await downloading
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url === firstUrl ? prefix : suffix)))
    expect(await fetchSnapshot(urls, options)).toEqual(data)
    finishDamaged(new Response("damaged"))
    await failed
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })))
    expect(await fetchSnapshot(urls, options)).toEqual(data)
  })

  it.each(["match", "keys", "delete", "put"] as const)("loads the snapshot when Cache Storage %s() throws", async (method) => {
    const data = new Uint8Array(randomBytes(1000))
    const [part] = packSnapshot(data)
    const stored = new Map<string, Response>([["https://docs.test/old.0.bin", new Response("old")]])
    const cache = {
      match: async (url: string) => stored.get(url)?.clone(),
      put: async (url: string, response: Response) => { stored.set(url, response) },
      keys: async () => [...stored.keys()].map(url => new Request(url)),
      delete: async (request: Request) => stored.delete(request.url),
    }
    cache[method] = () => { throw new DOMException("The operation is insecure.", "SecurityError") }
    vi.stubGlobal("caches", { open: async () => cache })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(part)))
    expect(await fetchSnapshot(["https://docs.test/new.0.bin"], { cache: "app" })).toEqual(data)
    expect(stored.has("https://docs.test/new.0.bin")).toBe(method !== "put")
  })

  it("keeps the previous version for an offline rollback when a put fails", async () => {
    const oldData = new Uint8Array(randomBytes(1000))
    const [oldPart] = packSnapshot(oldData)
    const data = new Uint8Array(randomBytes(300_000))
    const parts = packSnapshot(data, { partBytes: 50_000 })
    const urls = parts.map((_, index) => `https://docs.test/new.${index}.bin`)
    const stored = new Map<string, Response>([["https://docs.test/old.0.bin", new Response(oldPart)]])
    vi.stubGlobal("caches", { open: async () => ({
      match: async (url: string) => stored.get(url)?.clone(),
      put: async (url: string, response: Response) => {
        if (url === urls[1]) throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
        stored.set(url, response)
      },
      keys: async () => [...stored.keys()].map(url => new Request(url)),
      delete: async (request: Request) => stored.delete(request.url),
    }) })
    const fetchPart = vi.fn(async (url: string) => new Response(parts[urls.indexOf(url)]))
    vi.stubGlobal("fetch", fetchPart)
    expect(await fetchSnapshot(urls, { cache: "app" })).toEqual(data)
    expect([...stored.keys()].sort()).toEqual(["https://docs.test/old.0.bin", ...urls.filter(url => url !== urls[1])].sort())
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    expect(await fetchSnapshot(["https://docs.test/old.0.bin"], { cache: "app" })).toEqual(oldData)
  })

  it("stores its parts again when a load from the cache finishes after another version replaced them", async () => {
    const oldData = new Uint8Array(randomBytes(1000))
    const [oldPart] = packSnapshot(oldData)
    const [newPart] = packSnapshot(new Uint8Array(randomBytes(1000)))
    const stored = new Map<string, Response>([["https://docs.test/old.0.bin", new Response(oldPart)]])
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reading = false
    vi.stubGlobal("caches", { open: async () => ({
      match: async (url: string) => {
        if (reading || !stored.has(url)) return stored.get(url)?.clone()
        reading = true
        return new Response(new ReadableStream({
          async pull(controller) {
            await gate
            controller.enqueue(oldPart)
            controller.close()
          },
        }))
      },
      put: async (url: string, response: Response) => { stored.set(url, response) },
      keys: async () => [...stored.keys()].map(url => new Request(url)),
      delete: async (request: Request) => stored.delete(request.url),
    }) })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(newPart)))
    const oldLoad = fetchSnapshot(["https://docs.test/old.0.bin"], { cache: "app" })
    await vi.waitFor(() => expect(reading).toBe(true))
    await fetchSnapshot(["https://docs.test/new.0.bin"], { cache: "app" })
    expect([...stored.keys()]).toEqual(["https://docs.test/new.0.bin"])
    release()
    expect(await oldLoad).toEqual(oldData)
    expect([...stored.keys()]).toEqual(["https://docs.test/old.0.bin"])
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    expect(await fetchSnapshot(["https://docs.test/old.0.bin"], { cache: "app" })).toEqual(oldData)
  })

  it("keeps one whole version when two versions finish loading at the same time", async () => {
    const stored = new Map<string, Response>()
    vi.stubGlobal("caches", { open: async () => ({
      match: async (url: string) => stored.get(url)?.clone(),
      put: async (url: string, response: Response) => {
        await new Promise(resolve => setTimeout(resolve, 20))
        stored.set(url, response)
      },
      keys: async () => {
        await new Promise(resolve => setTimeout(resolve, 30))
        return [...stored.keys()].map(url => new Request(url))
      },
      delete: async (request: Request) => stored.delete(request.url),
    }) })
    const versions = ["a", "b"].map(name => ({ data: new Uint8Array(randomBytes(1000)), name }))
    const packed = new Map(versions.map(version => [`https://docs.test/${version.name}.0.bin`, packSnapshot(version.data)[0]!]))
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(packed.get(url))))
    const loaded = await Promise.all(versions.map(version => fetchSnapshot([`https://docs.test/${version.name}.0.bin`], { cache: "app" })))
    expect(loaded).toEqual(versions.map(version => version.data))
    expect(stored.size).toBe(1)
  })

  it("rejects when a part is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })))
    await expect(fetchSnapshot(["/parts/0"])).rejects.toThrow("Snapshot part /parts/0 returned 404.")
  })

  it("restores links after it mounts a snapshot that lists them, and loads the snapshot while it boots", async () => {
    const { container: booted, written } = container(true)
    let resolveSnapshot!: (data: Uint8Array) => void
    const loading = new Promise<Uint8Array>((resolve) => { resolveSnapshot = resolve })
    const boot = bootWebContainer({ snapshot: loading, files: { "index.js": "" } })
    await vi.waitFor(() => expect(api.boot).toHaveBeenCalled())
    resolveSnapshot(new Uint8Array([1]))
    await boot
    expect(booted.mount).toHaveBeenCalledTimes(2)
    expect(booted.spawn).toHaveBeenCalledWith("node", ["node_modules/.vitehub-restore-links.cjs"])
    expect(written.get("node_modules/.vitehub-restore-links.cjs")).toContain("symlinkSync")
  })

  it("runs nothing for a snapshot without a links list", async () => {
    const { container: booted } = container(false)
    await bootWebContainer({ snapshot: new Uint8Array([1]) })
    expect(booted.spawn).not.toHaveBeenCalled()
  })
})
