import { createServer, preview } from "vite"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { hubWebContainer, matchesWebContainerRoute, webContainerHeaders } from "../src/vite.ts"

describe("matchesWebContainerRoute", () => {
  it("matches exact paths and /** prefixes", () => {
    const routes = ["/playground/**", "/tutorial"]
    expect(matchesWebContainerRoute("/playground", routes)).toBe(true)
    expect(matchesWebContainerRoute("/playground/", routes)).toBe(true)
    expect(matchesWebContainerRoute("/playground/agents/first", routes)).toBe(true)
    expect(matchesWebContainerRoute("/playgrounds", routes)).toBe(false)
    expect(matchesWebContainerRoute("/tutorial", routes)).toBe(true)
    expect(matchesWebContainerRoute("/tutorial/step-1", routes)).toBe(false)
    expect(matchesWebContainerRoute("/", routes)).toBe(false)
    expect(matchesWebContainerRoute("/anything", ["/**"])).toBe(true)
  })
})

describe("hubWebContainer", () => {
  it("rejects missing or relative routes", () => {
    expect(() => hubWebContainer({ routes: [] })).toThrow(/at least one route/)
    expect(() => hubWebContainer({ routes: ["playground"] })).toThrow(/must start with "\/"/)
  })

  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "vitehub-web-container-"))
    await writeFile(join(root, "index.html"), "<!doctype html><title>home</title>")
    await mkdir(join(root, "playground"))
    await writeFile(join(root, "playground/index.html"), "<!doctype html><title>playground</title>")
  })
  afterAll(async () => {
    await rm(root, { force: true, recursive: true })
  })

  async function headersOf(origin: string, path: string) {
    const response = await fetch(new URL(path, origin))
    await response.arrayBuffer()
    return {
      coep: response.headers.get("cross-origin-embedder-policy"),
      coop: response.headers.get("cross-origin-opener-policy"),
    }
  }

  const isolated = { coep: webContainerHeaders["Cross-Origin-Embedder-Policy"], coop: webContainerHeaders["Cross-Origin-Opener-Policy"] }
  const plain = { coep: null, coop: null }

  it("sets the isolation headers only on configured routes in vite dev", async () => {
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      plugins: [hubWebContainer({ routes: ["/playground/**"] })],
      root,
      server: { host: "127.0.0.1", port: 0 },
    })
    await server.listen()
    try {
      const origin = server.resolvedUrls!.local[0]!
      expect(await headersOf(origin, "/playground/")).toEqual(isolated)
      expect(await headersOf(origin, "/")).toEqual(plain)
    }
    finally {
      await server.close()
    }
  })

  it("sets the isolation headers only on configured routes in vite preview", async () => {
    await mkdir(join(root, "dist/playground"), { recursive: true })
    await writeFile(join(root, "dist/index.html"), "<!doctype html><title>home</title>")
    await writeFile(join(root, "dist/playground/index.html"), "<!doctype html><title>playground</title>")
    const server = await preview({
      configFile: false,
      logLevel: "silent",
      plugins: [hubWebContainer({ routes: ["/playground/**"] })],
      preview: { host: "127.0.0.1", port: 0 },
      root,
    })
    try {
      const origin = server.resolvedUrls!.local[0]!
      expect(await headersOf(origin, "/playground/")).toEqual(isolated)
      expect(await headersOf(origin, "/")).toEqual(plain)
    }
    finally {
      await server.close()
    }
  })
})
