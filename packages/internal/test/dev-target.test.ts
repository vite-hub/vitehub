import { createServer, request } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resolveConfig } from "vite"

import {
  defaultViteHubDevServerUrl,
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
  viteHubDevEndpointUrl,
} from "../src/cli.ts"
import { isViteHubDevHostAllowed, registerViteHubDevEndpoint, validateViteHubDevRequest } from "../src/dev-endpoint.ts"

import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { ViteHubDevTargetArgs } from "../src/cli.ts"
import type { ViteHubDevEndpointServer } from "../src/dev-endpoint.ts"

const endpoint = { header: "x-test-dev", headerValue: "1", route: "/__test/dev" }

class TestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const errors = {
  invalidInlineTimeout: (message: string) => new TestError("inline", message),
  invalidTimeout: (message: string) => new TestError("separate", message),
  missingValue: (message: string) => new TestError("missing", message),
}

function parseTarget(args: string[]): ViteHubDevTargetArgs & { rest: string[] } {
  const target: ViteHubDevTargetArgs & { rest: string[] } = { rest: [], url: defaultViteHubDevServerUrl }
  for (let index = 0; index < args.length; index++) {
    const used = readViteHubDevTargetOption(args, index, target, errors)
    if (used === undefined) target.rest.push(args[index]!)
    else index += used
  }
  return target
}

function captureStderr() {
  const chunks: string[] = []
  return { stderr: { write: (chunk: string | Uint8Array) => chunks.push(String(chunk)) }, text: () => chunks.join("") }
}

describe("dev target options", () => {
  it("reads the default URL from the environment", () => {
    expect(resolveViteHubDevServerUrl({})).toBe("http://localhost:5173")
    expect(resolveViteHubDevServerUrl({ VITEHUB_DEV_SERVER_URL: "http://127.0.0.1:4000" })).toBe("http://127.0.0.1:4000")
  })

  it("reads --url, --server, --url=, --timeout and --timeout= and leaves other arguments", () => {
    expect(parseTarget(["--url", "http://a", "x", "--timeout", "10"])).toEqual({ rest: ["x"], timeout: 10, url: "http://a" })
    expect(parseTarget(["--server", "http://b", "--timeout=20", "--other"])).toEqual({ rest: ["--other"], timeout: 20, url: "http://b" })
    expect(parseTarget(["--url=http://c"])).toEqual({ rest: [], url: "http://c" })
  })

  it("uses the owner error factories", () => {
    expect(() => parseTarget(["--url"])).toThrow(expect.objectContaining({ code: "missing", message: "Missing value for --url." }))
    expect(() => parseTarget(["--server", "--timeout"])).toThrow(expect.objectContaining({ code: "missing", message: "Missing value for --server." }))
    expect(() => parseTarget(["--timeout", "0"])).toThrow(expect.objectContaining({ code: "separate", message: "--timeout must be a positive number." }))
    expect(() => parseTarget(["--timeout=abc"])).toThrow(expect.objectContaining({ code: "inline", message: "--timeout must be a positive number." }))
  })

  it("resolves endpoint routes with and without a trailing slash", () => {
    expect(viteHubDevEndpointUrl("http://localhost:5173", endpoint.route)).toBe("http://localhost:5173/__test/dev")
    expect(viteHubDevEndpointUrl("http://localhost:5173/", endpoint.route)).toBe("http://localhost:5173/__test/dev")
  })
})

describe("dev server discovery", () => {
  it("adds the guard header to endpoint calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"))
    await fetchViteHubDevEndpoint(fetchImpl, "http://localhost/__test/dev", endpoint, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost/__test/dev", {
      body: "{}",
      headers: { "content-type": "application/json", "x-test-dev": "1" },
      method: "POST",
    })
  })

  it("returns the discovery body and endpoint URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ items: ["a"], root: "/app" }))
    const output = captureStderr()
    const target = await discoverViteHubDevServer<{ items?: string[], root?: string }>({
      endpoint,
      fetch: fetchImpl,
      rootDir: "/app",
      serverUrl: "http://localhost:5173",
      stderr: output.stderr,
    })
    expect(target).toEqual({ discovery: { items: ["a"], root: "/app" }, url: "http://localhost:5173/__test/dev" })
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:5173/__test/dev", { headers: { accept: "application/json", "x-test-dev": "1" } })
    expect(output.text()).toBe("")
  })

  it("reports invalid URLs, missing servers, failed responses and root mismatches", async () => {
    const cases: Array<{ fetch: typeof fetch, isCompatibleRoot?: (rootDir: string, serverRoot: string) => boolean, message: string, serverUrl: string }> = [
      { fetch: async () => new Response(), message: "Invalid Vite Development Server URL: not a url\n", serverUrl: "not a url" },
      { fetch: async () => { throw new TypeError("fetch failed") }, message: "No Compatible Vite Development Server found at http://localhost:1.\n", serverUrl: "http://localhost:1" },
      { fetch: async () => new Response("no", { status: 404 }), message: "No Compatible Vite Development Server found at http://localhost:2.\n", serverUrl: "http://localhost:2" },
      { fetch: async () => Response.json({ root: "/other" }), message: "Compatible Vite Development Server root mismatch: /other\n", serverUrl: "http://localhost:3" },
    ]
    for (const input of cases) {
      const output = captureStderr()
      const target = await discoverViteHubDevServer({ endpoint, fetch: input.fetch, rootDir: "/app", serverUrl: input.serverUrl, stderr: output.stderr })
      expect(target).toBeUndefined()
      expect(output.text()).toBe(input.message)
    }
  })

  it("validates the discovery object and accepts an owner parser", async () => {
    const output = captureStderr()
    const options = { endpoint, rootDir: "/app", serverUrl: "http://localhost:5173", stderr: output.stderr }
    expect((await discoverViteHubDevServer({ ...options, fetch: async () => Response.json(null) }))?.discovery).toEqual({})
    const target = await discoverViteHubDevServer({ ...options, fetch: async () => Response.json({ id: 7 }), parseDiscovery: () => ({ root: "/app", id: 7 }) })
    expect(target?.discovery.id).toBe(7)
  })

  it("uses the owner root check", async () => {
    const output = captureStderr()
    const target = await discoverViteHubDevServer({
      endpoint,
      fetch: async () => Response.json({ root: "/app/nested" }),
      isCompatibleRoot: (rootDir, serverRoot) => serverRoot.startsWith(`${rootDir}/`),
      rootDir: "/app",
      serverUrl: "http://localhost:5173",
      stderr: output.stderr,
    })
    expect(target?.discovery).toEqual({ root: "/app/nested" })
  })
})

describe("guarded dev endpoint", () => {
  let http: Server | undefined

  afterEach(async () => {
    await new Promise<void>(resolve => http ? http.close(() => resolve()) : resolve())
    http = undefined
  })

  async function listen(options: { methods?: readonly string[], server?: ViteHubDevEndpointServer["config"]["server"] }): Promise<{ handled: string[], url: string }> {
    const handlers: Array<(req: IncomingMessage, res: ServerResponse, next: () => void) => void> = []
    const handled: string[] = []
    const server: ViteHubDevEndpointServer = {
      config: { server: options.server ?? {} },
      middlewares: { use: handler => handlers.push(handler) },
      resolvedUrls: null,
    }
    registerViteHubDevEndpoint(server, {
      handle: (req, res) => {
        handled.push(req.method || "")
        res.end("handled")
      },
      header: endpoint.header,
      headerValue: endpoint.headerValue,
      label: "Test Dev",
      ...(options.methods ? { methods: options.methods } : {}),
      route: endpoint.route,
    })
    http = createServer((req, res) => {
      handlers[0]!(req, res, () => {
        res.statusCode = 404
        res.end("next")
      })
    })
    await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", () => resolve()))
    const address = http.address()
    if (!address || typeof address === "string") throw new Error("Test server has no port.")
    return { handled, url: `http://127.0.0.1:${address.port}` }
  }

  it("passes other routes to the next middleware", async () => {
    const { handled, url } = await listen({})
    const response = await fetch(`${url}/other`)
    expect(await response.text()).toBe("next")
    expect(handled).toEqual([])
  })

  it("rejects requests without the guard header, from another origin, or without JSON", async () => {
    const { handled, url } = await listen({})
    const route = `${url}${endpoint.route}`
    const missing = await fetch(route)
    expect([missing.status, await missing.text()]).toEqual([403, "Forbidden Test Dev request."])
    const origin = await fetch(route, { headers: { [endpoint.header]: "1", origin: "http://evil.test" } })
    expect([origin.status, await origin.text()]).toEqual([403, "Forbidden Test Dev origin."])
    const text = await fetch(route, { body: "x", headers: { "content-type": "text/plain", [endpoint.header]: "1" }, method: "POST" })
    expect([text.status, await text.text()]).toEqual([415, "Test Dev requests must use application/json."])
    expect(handled).toEqual([])
  })

  it("calls the handler for guarded requests from the same origin", async () => {
    const { handled, url } = await listen({})
    const get = await fetch(`${url}${endpoint.route}?x=1`, { headers: { [endpoint.header]: "1", origin: url } })
    expect(await get.text()).toBe("handled")
    const post = await fetch(`${url}${endpoint.route}`, { body: "{}", headers: { "content-type": "application/json", [endpoint.header]: "1" }, method: "POST" })
    expect(await post.text()).toBe("handled")
    expect(handled).toEqual(["GET", "POST"])
  })

  it("rejects methods outside the allowed list before the guard", async () => {
    const { handled, url } = await listen({ methods: ["GET", "POST"] })
    const response = await fetch(`${url}${endpoint.route}`, { method: "DELETE" })
    expect([response.status, await response.text()]).toEqual([405, "Method not allowed."])
    expect(handled).toEqual([])
  })

  it("derives the request origin from the host header", () => {
    const server = { config: { server: { allowedHosts: ["example.test"], port: 5173 } }, resolvedUrls: { local: ["https://localhost:5173/"] } }
    const req = { headers: { host: "example.test:5173", origin: "https://example.test:5173", [endpoint.header]: "1" }, method: "GET" }
    // SAFETY: the guard reads only headers and method from the request.
    expect(validateViteHubDevRequest(server, req as unknown as IncomingMessage, { ...endpoint, label: "Test Dev" })).toBeUndefined()
  })

  // Node fetch does not send a custom Host header, so these requests use node:http.
  function requestWithHost(url: string, host: string): Promise<[number | undefined, string]> {
    return new Promise((resolve, reject) => {
      const req = request(`${url}${endpoint.route}`, {
        headers: { host, origin: `http://${host}`, [endpoint.header]: "1" },
      }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => { body += chunk })
        res.on("end", () => resolve([res.statusCode, body]))
      })
      req.on("error", reject)
      req.end()
    })
  }

  it("rejects a DNS rebinding host with a matching origin before the handler", async () => {
    const { handled, url } = await listen({})
    const port = new URL(url).port
    expect(await requestWithHost(url, `attacker.example:${port}`)).toEqual([403, "Forbidden Test Dev host."])
    expect(await requestWithHost(url, `localhost:${port}`)).toEqual([200, "handled"])
    expect(await requestWithHost(url, `127.0.0.1:${port}`)).toEqual([200, "handled"])
    expect(handled).toEqual(["GET", "GET"])
  })

  it("accepts configured allowed hosts and allowedHosts: true", async () => {
    const configured = await listen({ server: { allowedHosts: ["app.test", ".tunnel.test"] } })
    const port = new URL(configured.url).port
    expect(await requestWithHost(configured.url, `app.test:${port}`)).toEqual([200, "handled"])
    expect(await requestWithHost(configured.url, `dev.tunnel.test:${port}`)).toEqual([200, "handled"])
    expect(await requestWithHost(configured.url, `attacker.example:${port}`)).toEqual([403, "Forbidden Test Dev host."])
    await new Promise<void>(resolve => http!.close(() => resolve()))
    const all = await listen({ server: { allowedHosts: true } })
    expect(await requestWithHost(all.url, `attacker.example:${new URL(all.url).port}`)).toEqual([200, "handled"])
  })

  it("uses Vite's resolved environment host list without reading later environment changes", async () => {
    vi.stubEnv("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", " foo.test, bar.test, , ")
    try {
      const config = await resolveConfig({ configFile: false, server: {} }, "serve", "development")
      vi.stubEnv("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", "attacker.test")
      const local = await listen({ server: config.server })
      const port = new URL(local.url).port
      expect(await requestWithHost(local.url, `foo.test:${port}`)).toEqual([200, "handled"])
      expect(await requestWithHost(local.url, `bar.test:${port}`)).toEqual([200, "handled"])
      expect(await requestWithHost(local.url, `attacker.test:${port}`)).toEqual([403, "Forbidden Test Dev host."])
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("matches Vite host validation rules", () => {
    const allowed = (host: string | undefined, server: ViteHubDevEndpointServer["config"]["server"] = {}) =>
      // SAFETY: the host check reads only the host header from the request.
      isViteHubDevHostAllowed({ config: { server } }, { headers: host === undefined ? {} : { host } } as unknown as IncomingMessage)
    expect(allowed(undefined)).toBe(true)
    expect(allowed("localhost")).toBe(true)
    expect(allowed("LOCALHOST:5173")).toBe(true)
    expect(allowed("APP.TEST:5173", { allowedHosts: ["app.test"] })).toBe(true)
    expect(allowed("app.test:5173", { allowedHosts: ["APP.TEST"] })).toBe(true)
    expect(allowed("app.localhost:5173")).toBe(true)
    expect(allowed("127.0.0.1:5173")).toBe(true)
    expect(allowed("192.168.1.20:5173")).toBe(true)
    expect(allowed("[::1]:5173")).toBe(true)
    expect(allowed("[not-ip]:5173")).toBe(false)
    expect(allowed("attacker.example:5173")).toBe(false)
    expect(allowed("attacker-extension:5173")).toBe(true)
    expect(allowed("file:5173")).toBe(true)
    expect(allowed("localhost.attacker.example")).toBe(false)
    expect(allowed("tunnel.test", { allowedHosts: [".tunnel.test"] })).toBe(true)
    expect(allowed("eviltunnel.test", { allowedHosts: [".tunnel.test"] })).toBe(false)
    expect(allowed("sub.app.test", { allowedHosts: ["app.test"] })).toBe(false)
    expect(allowed("machine.lan:5173", { host: "machine.lan" })).toBe(true)
    expect(allowed("machine.lan:5173", { host: true })).toBe(false)
    expect(allowed("tunnel.test:5173", { hmr: { host: "tunnel.test" } })).toBe(true)
    expect(allowed("tunnel.test:5173", { hmr: true })).toBe(false)
    expect(allowed("app.test:5173", { origin: "https://app.test:8443/app/" })).toBe(true)
    expect(allowed("attacker.example", { origin: "not a URL" })).toBe(false)
    expect(allowed("attacker.example", { hmr: { host: "tunnel.test" }, origin: "https://app.test" })).toBe(false)
    expect(allowed("attacker.example", { allowedHosts: true })).toBe(true)
    expect(allowed("attacker.example", { https: {} })).toBe(true)
  })
})
