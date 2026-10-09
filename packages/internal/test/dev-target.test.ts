import { createServer, request } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  defaultViteHubDevServerUrl,
  discoverViteHubDevServer,
  fetchViteHubDevEndpoint,
  readViteHubDevTargetOption,
  resolveViteHubDevServerUrl,
  viteHubDevEndpointUrl,
} from "../src/cli.ts"
import { assertViteHubDevRequestGrant, isViteHubDevHostAllowed, registerViteHubDevEndpoint, validateViteHubDevRequest } from "../src/dev-endpoint.ts"
import { isViteHubSecretEqual } from "../src/secret.ts"

import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { ViteHubDevTargetArgs } from "../src/cli.ts"
import type { ViteHubDevEndpointOptions, ViteHubDevEndpointServer } from "../src/dev-endpoint.ts"

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
    expect(() => parseTarget(["--timeout", "0"])).toThrow(expect.objectContaining({ code: "separate", message: "--timeout must be an integer from 1 to 2147483647 milliseconds." }))
    expect(() => parseTarget(["--timeout=abc"])).toThrow(expect.objectContaining({ code: "inline", message: "--timeout must be an integer from 1 to 2147483647 milliseconds." }))
  })

  it.each([
    { args: ["--timeout", "2147483648"], code: "separate" },
    { args: ["--timeout=2147483648"], code: "inline" },
  ])("rejects timer overflow with the owner $code factory", ({ args, code }) => {
    expect(() => parseTarget(args)).toThrow(expect.objectContaining({ code, message: "--timeout must be at most 2147483647 milliseconds." }))
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
      redirect: "manual",
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
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:5173/__test/dev", { headers: { accept: "application/json", "x-test-dev": "1" }, redirect: "manual" })
    expect(output.text()).toBe("")
  })

  it("reports invalid URLs, missing servers, malformed roots and root mismatches", async () => {
    const cases: Array<{ fetch: typeof fetch, isCompatibleRoot?: (rootDir: string, serverRoot: string) => boolean, message: string, serverUrl: string }> = [
      { fetch: async () => new Response(), message: "Invalid Vite Development Server URL: not a url\n", serverUrl: "not a url" },
      { fetch: async () => { throw new TypeError("fetch failed") }, message: "No Compatible Vite Development Server found at http://localhost:1.\n", serverUrl: "http://localhost:1" },
      { fetch: async () => new Response("no", { status: 404 }), message: "No Compatible Vite Development Server found at http://localhost:2.\n", serverUrl: "http://localhost:2" },
      { fetch: async () => Response.json({ root: 123 }), message: "Invalid Vite Development Server discovery root.\n", serverUrl: "http://localhost:4" },
      { fetch: async () => Response.json({ root: "/other" }), message: "Compatible Vite Development Server root mismatch: /other\n", serverUrl: "http://localhost:3" },
      { fetch: async () => Response.json({ root: "https://host/project?token=hidden" }), message: "Compatible Vite Development Server root mismatch: https://host/project?token=[redacted]\n", serverUrl: "http://localhost:4" },
      { fetch: async () => Response.json({ root: "https://user:pass@example.test/project/token=hidden#api_key=secret" }), message: "Compatible Vite Development Server root mismatch: https://[redacted]@example.test/project/token=[redacted]#api_key=[redacted]\n", serverUrl: "http://localhost:5" },
      { fetch: async () => Response.json({ root: "https://host/project?target=https%3A%2F%2Fuser%3Apass%40example.test&target=public" }), message: "Compatible Vite Development Server root mismatch: https://host/project?target=[redacted]&target=public\n", serverUrl: "http://localhost:6" },
      { fetch: async () => Response.json({ root: "https://host/project#%74oken=secret" }), message: "Compatible Vite Development Server root mismatch: https://host/project#%74oken=[redacted]\n", serverUrl: "http://localhost:7" },
      { fetch: async () => Response.json({ root: "https://host:bad/path?%74oken=secret" }), message: "Compatible Vite Development Server root mismatch: https://host:bad/path?%74oken=[redacted]\n", serverUrl: "http://localhost:8" },
      { fetch: async () => Response.json({ root: "https://host/project?next=Bearer%20secret&next=public#next=prefix%20https%3A%2F%2Fuser%3Apass%40example.test" }), message: "Compatible Vite Development Server root mismatch: https://host/project?next=[redacted]&next=public#next=[redacted]\n", serverUrl: "http://localhost:9" },
      { fetch: async () => Response.json({ root: "https://host:bad/path?next=Bearer%20secret#next=prefix%20token%3Dhidden" }), message: "Compatible Vite Development Server root mismatch: https://host:bad/path?next=[redacted]#next=[redacted]\n", serverUrl: "http://localhost:10" },
      { fetch: async () => new Response(), message: "Invalid Vite Development Server URL: https://host:bad/path?next=[redacted]#next=[redacted]\n", serverUrl: "https://host:bad/path?next=prefix%20Bearer%20secret#next=prefix%20token%3Dhidden" },
    ]
    for (const input of cases) {
      const output = captureStderr()
      const target = await discoverViteHubDevServer({ endpoint, fetch: input.fetch, rootDir: "/app", serverUrl: input.serverUrl, stderr: output.stderr })
      expect(target).toBeUndefined()
      expect(output.text()).toBe(input.message)
    }
  })

  it("redacts credentials when discovery completes after cancellation", async () => {
    const controller = new AbortController()
    const output = captureStderr()
    const target = await discoverViteHubDevServer({
      endpoint,
      fetch: async () => {
        controller.abort()
        return Response.json({ root: "/app" })
      },
      rootDir: "/app",
      serverUrl: "http://user:pass@localhost:5173?next=prefix%20Bearer%20secret&next=public#next=prefix%20token%3Dhidden",
      signal: controller.signal,
      stderr: output.stderr,
    })
    expect(target).toBeUndefined()
    expect(output.text()).toBe("No Compatible Vite Development Server found at http://[redacted]@localhost:5173/?next=[redacted]&next=public#next=[redacted].\n")
  })

  it("uses an empty discovery object for a non-object response without an owner parser", async () => {
    const output = captureStderr()
    const target = await discoverViteHubDevServer({
      endpoint,
      fetch: async () => Response.json(null),
      rootDir: "/app",
      serverUrl: "http://localhost:5173",
      stderr: output.stderr,
    })
    expect(target?.discovery).toEqual({})
    expect(output.text()).toBe("")
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

  async function listen(options: { authorize?: ViteHubDevEndpointOptions["authorize"], methods?: readonly string[], server?: ViteHubDevEndpointServer["config"]["server"] }): Promise<{ handled: string[], url: string }> {
    const handlers: Array<(req: IncomingMessage, res: ServerResponse, next: () => void) => void> = []
    const handled: string[] = []
    const server: ViteHubDevEndpointServer = {
      config: { server: options.server ?? {} },
      middlewares: { use: handler => handlers.push(handler) },
      resolvedUrls: null,
    }
    registerViteHubDevEndpoint(server, {
      ...(options.authorize ? { authorize: options.authorize } : {}),
      handle: (req, res, grant) => {
        handled.push(req.method || "")
        try {
          assertViteHubDevRequestGrant(grant, req)
          res.end("handled")
        }
        catch {
          res.end("no grant")
        }
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
    const wrong = await fetch(route, { headers: { [endpoint.header]: "10" } })
    expect([wrong.status, await wrong.text()]).toEqual([403, "Forbidden Test Dev request."])
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

  it("runs owner authorization before the handler gets the grant", async () => {
    const { handled, url } = await listen({
      authorize: async req => isViteHubSecretEqual(req.headers["x-test-token"] as string | undefined, "secret")
        ? undefined
        : new Response("Forbidden Test Dev token.", { status: 403 }),
    })
    const route = `${url}${endpoint.route}`
    const missing = await fetch(route, { headers: { [endpoint.header]: "1" } })
    expect([missing.status, await missing.text()]).toEqual([403, "Forbidden Test Dev token."])
    const wrong = await fetch(route, { headers: { [endpoint.header]: "1", "x-test-token": "secreT" } })
    expect([wrong.status, await wrong.text()]).toEqual([403, "Forbidden Test Dev token."])
    expect(handled).toEqual([])
    const allowed = await fetch(route, { headers: { [endpoint.header]: "1", "x-test-token": "secret" } })
    expect(await allowed.text()).toBe("handled")
    expect(handled).toEqual(["GET"])
  })

  it("returns a redacted 500 when owner authorization fails", async () => {
    const { handled, url } = await listen({ authorize: () => { throw new Error("Bearer private-secret") } })
    const response = await fetch(`${url}${endpoint.route}`, { headers: { [endpoint.header]: "1" } })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { message: "Test Dev request failed: Bearer [redacted]" } })
    expect(handled).toEqual([])
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
    expect(validateViteHubDevRequest(server, req as unknown as IncomingMessage, { ...endpoint, label: "Test Dev" }).grant?.label).toBe("Test Dev")
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

  it("matches Vite host validation rules", () => {
    const allowed = (host: string | undefined, server: ViteHubDevEndpointServer["config"]["server"] = {}) =>
      // SAFETY: the host check reads only the host header from the request.
      isViteHubDevHostAllowed({ config: { server } }, { headers: host === undefined ? {} : { host } } as unknown as IncomingMessage)
    expect(allowed(undefined)).toBe(true)
    expect(allowed("localhost")).toBe(true)
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
    expect(allowed("attacker.example", { allowedHosts: true })).toBe(true)
    expect(allowed("attacker.example", { https: {} })).toBe(true)
  })
})
