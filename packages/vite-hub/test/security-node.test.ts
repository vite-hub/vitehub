import { Socket } from "node:net"
import { IncomingMessage, ServerResponse, request as httpRequest } from "node:http"
import { NodeRequest, serve, toFetchHandler } from "srvx/node"
import { describe, expect, it } from "vitest"
import { installSecurity } from "../src/_internal/runtime/security.ts"

const defaults: Array<[string, string]> = [["X-Frame-Options", "SAMEORIGIN"]]

describe("native Node security", () => {
  it("enforces the cap through the Node adapter without a listening socket", async () => {
    const handler = toFetchHandler(async (req: IncomingMessage, res: ServerResponse) => {
      let size = 0
      for await (const chunk of req) size += chunk.length
      res.setHeader("X-Frame-Options", "DENY")
      res.end(JSON.stringify({ size }))
    })
    const app = { fetch: (request: Request) => handler(request) }
    installSecurity(app, { headers: defaults, maxBodySize: 16 })
    const send = (size: number) => {
      const req = new IncomingMessage(new Socket())
      req.method = "POST"
      req.url = "/"
      req.headers.host = "app.test"
      req.complete = true
      req.push(Buffer.alloc(size))
      req.push(null)
      return app.fetch(new NodeRequest({ req, res: new ServerResponse(req) }))
    }
    const small = await send(8)
    expect(small.status).toBe(200)
    expect(small.headers.get("x-frame-options")).toBe("DENY")
    expect(await small.json()).toEqual({ size: 8 })
    const large = await send(64)
    expect(large.status).toBe(413)
    expect(large.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(await large.json()).toMatchObject({ data: { code: "VITE_HUB_REQUEST_BODY_TOO_LARGE" } })
  })

  it("adds defaults to a native response when only headers are configured", async () => {
    const handler = toFetchHandler((_req: IncomingMessage, res: ServerResponse) => { res.end("ok") })
    const app = { fetch: (request: Request) => handler(request) }
    installSecurity(app, { headers: defaults })
    const req = new IncomingMessage(new Socket())
    req.method = "GET"
    req.url = "/"
    req.headers.host = "app.test"
    req.complete = true
    const response = await app.fetch(new NodeRequest({ req, res: new ServerResponse(req) }))
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(await response.text()).toBe("ok")
  })

  it("limits chunked bodies and preserves native route headers over real HTTP", async () => {
    const handler = toFetchHandler(async (req: IncomingMessage, res: ServerResponse) => {
      let size = 0
      for await (const chunk of req) size += chunk.length
      if (req.url === "/own") res.setHeader("X-Frame-Options", "DENY")
      res.end(JSON.stringify({ size }))
    })
    const app = { fetch: (request: Request) => handler(request) }
    installSecurity(app, { headers: defaults, maxBodySize: 16 })
    const server = serve({ fetch: app.fetch, port: 0, silent: true })
    await server.ready()
    try {
      const post = (path: string, size: number) => new Promise<{ status: number | undefined, headers: import("node:http").IncomingHttpHeaders, body: string }>((resolve, reject) => {
        const req = httpRequest(new URL(path, server.url), { method: "POST" }, (res) => {
          let body = ""
          res.on("data", chunk => body += chunk)
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }))
        })
        req.on("error", reject)
        req.write("x".repeat(size))
        req.end()
      })
      const small = await post("/", 8)
      expect(small.status).toBe(200)
      expect(JSON.parse(small.body)).toEqual({ size: 8 })
      expect(small.headers["x-frame-options"]).toBe("SAMEORIGIN")
      expect((await post("/own", 8)).headers["x-frame-options"]).toBe("DENY")
      const large = await post("/", 64)
      expect(large.status).toBe(413)
      expect(large.headers["x-frame-options"]).toBe("SAMEORIGIN")
      expect(JSON.parse(large.body)).toMatchObject({ data: { code: "VITE_HUB_REQUEST_BODY_TOO_LARGE" } })
    }
    finally {
      await server.close()
    }
  })
})
