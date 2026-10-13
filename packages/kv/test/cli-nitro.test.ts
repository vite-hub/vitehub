import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"

import { describe, expect, it } from "vitest"
import { createServer } from "vite"

import { runKVCli } from "../src/cli.ts"
import { kvDevRoute } from "../src/dev.ts"
import { hubKv } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

/** Sends one Fetch API request through the Vite middleware stack without a listening port. */
async function viaMiddlewares(middlewares: Connect.Server, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
  const req = Object.assign(Readable.from(body ? [body] : []), {
    headers: Object.fromEntries(request.headers),
    method: request.method,
    url: `${url.pathname}${url.search}`,
  }) as unknown as IncomingMessage
  req.headers.host = url.host
  return await new Promise<Response>((resolveResponse, reject) => {
    const chunks: Buffer[] = []
    const headers = new Headers()
    const res = Object.assign(new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
      final(callback) {
        resolveResponse(new Response(Buffer.concat(chunks), { headers, status: res.statusCode }))
        callback()
      },
    }), {
      setHeader(name: string, value: string) {
        headers.set(name, value)
      },
      statusCode: 200,
    })
    middlewares(req, res as unknown as ServerResponse, (error?: unknown) => {
      if (error) reject(error)
      else resolveResponse(new Response("Not found", { status: 404 }))
    })
  })
}

describe("vitehub kv against a Vite + Nitro Development Server", () => {
  it("reaches the app KV storage through the Nitro dev environment", async () => {
    // SAFETY: Nitro publishes this Vite plugin at the runtime-resolved `nitro/vite` entry.
    const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
    // Nitro writes its dev worker with relative imports, so the app root stays inside the workspace and resolves packages normally.
    const tmp = resolve(import.meta.dirname, "../.vitest-tmp")
    await mkdir(tmp, { recursive: true })
    const root = await mkdtemp(join(tmp, "kv-cli-nitro-"))
    const server = await (async () => {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await writeFile(join(root, "package.json"), "{\"name\":\"kv-cli-nitro\",\"private\":true,\"type\":\"module\"}\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      return await createServer({
        appType: "custom",
        configFile: false,
        logLevel: "silent",
        plugins: [hubKv({ base: join(root, ".data", "kv"), driver: "fs-lite" }), nitro() as never],
        root,
        server: { middlewareMode: true, ws: false },
      })
    })()
    try {
      const fetch = (input: string | URL | Request, init?: RequestInit) => viaMiddlewares(server.middlewares, input, init)
      const run = async (args: string[]) => {
        const stdout = stream()
        const stderr = stream()
        const code = await runKVCli(args, { cwd: root, env: {}, rootDir: root, stderr, stdout }, { fetch })
        return { code, stderr: stderr.output(), stdout: stdout.output() }
      }

      const discovery = await fetch(`http://localhost:5173${kvDevRoute}`, { headers: { "x-vitehub-kv-dev": "1" } })
      expect(await discovery.json()).toMatchObject({ runtime: "nitro" })

      expect(await run(["set", "greeting", "hello"])).toEqual({ code: 0, stderr: "", stdout: "Created key greeting in store default (string).\n" })
      expect(await run(["get", "greeting"])).toEqual({ code: 0, stderr: "", stdout: "hello" })
      expect(await run(["list", "--json"])).toMatchObject({ code: 0, stdout: expect.stringContaining("\"greeting\"") })
      expect(await run(["del", "greeting"])).toEqual({ code: 0, stderr: "", stdout: "Deleted key greeting from store default.\n" })
      expect((await run(["has", "greeting"])).code).toBe(1)
    }
    finally {
      await server.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)
})
