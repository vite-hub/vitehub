import { randomBytes } from "node:crypto"
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
    expect(() => packSnapshot(new Uint8Array([1]), { partBytes })).toThrow(RangeError)
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
    // Random bytes do not compress, so the parts stay many.
    const data = new Uint8Array(randomBytes(300_000))
    const parts = packSnapshot(data, { partBytes: 50_000 })
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(part => part.byteLength <= 50_000)).toBe(true)
    // Parts arrive out of order. The order of the URLs decides.
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
