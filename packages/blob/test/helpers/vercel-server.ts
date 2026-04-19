import { createServer } from "node:http"
import { pathToFileURL } from "node:url"

const entry = process.argv[2]
const host = process.env.HOST || "127.0.0.1"
const port = Number(process.env.PORT || 3000)

const mod = await import(pathToFileURL(entry).href)
const handler = mod.default

const isNodeListener = typeof handler === "function" && (handler.length >= 2 || !("fetch" in handler))

const server = isNodeListener
  ? createServer(handler)
  : createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
        const headers: [string, string][] = Object.entries(req.headers).flatMap(([name, value]) => {
          if (value == null) return []
          return Array.isArray(value) ? value.map(item => [name, item] as [string, string]) : [[name, value] as [string, string]]
        })

        const request = new Request(
          new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`),
          {
            body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
            headers,
            method: req.method,
          },
        )

        const response = await handler.fetch(request, {
          waitUntil(promise: Promise<unknown>) {
            Promise.resolve(promise).catch(() => {})
          },
        })

        res.statusCode = response.status
        for (const [name, value] of response.headers) res.setHeader(name, value)
        res.end(Buffer.from(await response.arrayBuffer()))
      }
      catch (error) {
        res.statusCode = 500
        res.end(String(error))
      }
    })

server.listen(port, host)
process.on("SIGTERM", () => server.close(() => process.exit(0)))
