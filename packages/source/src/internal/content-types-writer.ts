import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export interface ContentTypesWriterHost {
  options?: { dev?: boolean, runtimeConfig?: Record<string, unknown> }
  hooks: { hook(name: "close", callback: () => Promise<void>): void }
}

const installed = new WeakMap<ContentTypesWriterHost, Promise<void>>()

/** Keep writes in the Nitro host, including when its runtime runs in workerd. */
export function installContentTypesWriter(host: ContentTypesWriterHost, plugin: string): Promise<void> {
  if (!host.options?.dev) return Promise.resolve()
  const previous = installed.get(host)
  if (previous) return previous
  const installation = startWriter(host, plugin)
  installed.set(host, installation)
  return installation
}

async function startWriter(host: ContentTypesWriterHost, plugin: string): Promise<void> {
  const file = resolve(dirname(plugin), "../types/content.d.ts")
  const path = `/${randomUUID()}`
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== path || request.headers.origin) {
      response.writeHead(403).end()
      return
    }
    void (async () => {
      request.setEncoding("utf8")
      let declarations = ""
      for await (const chunk of request) {
        declarations += String(chunk)
        if (declarations.length > 16 * 1024 * 1024) {
          response.writeHead(413).end()
          return
        }
      }
      const current = await readFile(file, "utf8").catch(() => undefined)
      if (current !== declarations) {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, declarations, "utf8")
      }
      response.writeHead(204).end()
    })().catch(() => response.writeHead(500).end())
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  server.unref()
  // Nuxt calls the Nitro close hook itself, so the hook runs again when the CLI has already closed Nitro.
  let closing: Promise<void> | undefined
  host.hooks.hook("close", () => closing ??= new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Content types writer has no TCP address.")
  host.options!.runtimeConfig ??= {}
  host.options!.runtimeConfig.vitehubContentTypesWriter = `http://127.0.0.1:${address.port}${path}`
}
