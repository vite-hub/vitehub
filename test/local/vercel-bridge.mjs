// Serves built Vercel Provider Output (.vercel/output) on a local Node HTTP
// server so Primitive Suites can run without a deployment. Routes follow
// config.json: schedule function paths hit their own function, everything
// else hits __server.func.
import { createServer } from "node:http"
import { existsSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

async function loadFunction(outputDir, funcPath) {
  const entry = resolve(outputDir, "functions", funcPath, "index.mjs")
  if (!existsSync(entry)) throw new Error(`[e2e:local] Missing Vercel function entry: ${entry}`)
  const mod = await import(pathToFileURL(entry).href)
  const handler = mod.default ?? mod.handler ?? mod.fetch
  if (typeof handler !== "function") {
    throw new Error(`[e2e:local] Vercel function at ${entry} has no callable default/handler/fetch export.`)
  }
  return handler
}

function nodeRequestToWebRequest(req, origin) {
  const url = new URL(req.url, origin)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value)
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item)
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req
  return new Request(url, { body, duplex: body ? "half" : undefined, headers, method: req.method })
}

async function writeWebResponse(res, response) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (!response.body) return res.end()
  for await (const chunk of response.body) res.write(chunk)
  res.end()
}

export async function createVercelBridge({ outputDir, port, env = {} }) {
  Object.assign(process.env, env)
  const serverHandler = await loadFunction(outputDir, "__server.func")
  const functionRoutes = []
  const scheduleFuncRoot = resolve(outputDir, "functions/api/vitehub/schedules")
  if (existsSync(scheduleFuncRoot)) {
    functionRoutes.push({
      load: path => loadFunction(outputDir, `${path.slice(1)}.func`),
      match: path => path.startsWith("/api/vitehub/schedules/"),
    })
  }
  const loaded = new Map()

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname
      let handler = serverHandler
      const route = functionRoutes.find(candidate => candidate.match(path))
      if (route) {
        if (!loaded.has(path)) loaded.set(path, await route.load(path))
        handler = loaded.get(path)
      }
      // Vercel Node functions are either web handlers (Request -> Response)
      // or Node (req, res) handlers; detect by arity and result shape.
      if (handler.length >= 2) {
        await handler(req, res)
        return
      }
      const result = await handler(nodeRequestToWebRequest(req, `http://127.0.0.1:${port}`))
      if (result instanceof Response) {
        await writeWebResponse(res, result)
        return
      }
      res.statusCode = 204
      res.end()
    }
    catch (error) {
      res.statusCode = 500
      res.end(`[e2e:local] bridge error: ${error instanceof Error ? error.stack : error}`)
    }
  })

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise)
    server.listen(port, "127.0.0.1", resolvePromise)
  })

  return {
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  }
}
