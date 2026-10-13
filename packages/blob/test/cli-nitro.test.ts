import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"

import { describe, expect, it } from "vitest"
import { createServer } from "vite"

import { runBlobCli } from "../src/cli.ts"
import { blobDevRoute } from "../src/dev.ts"
import { hubBlob } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"

function stream() {
  let value = ""
  const bytes: Uint8Array[] = []
  return {
    bytes: () => bytes,
    output: () => value,
    write(chunk: string | Uint8Array) {
      if (typeof chunk === "string") value += chunk
      else bytes.push(chunk)
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

// Every byte value, so a UTF-8 or JSON conversion anywhere in the path changes the result.
const binary = Uint8Array.from({ length: 256 }, (_, index) => index)

describe("vitehub blob against a Vite + Nitro Development Server", () => {
  it("round-trips binary files through the Nitro dev environment", async () => {
    // SAFETY: Nitro publishes this Vite plugin at the runtime-resolved `nitro/vite` entry.
    const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
    // Nitro writes its dev worker with relative imports, so the app root stays inside the workspace and resolves packages normally.
    const tmp = resolve(import.meta.dirname, "../.vitest-tmp")
    await mkdir(tmp, { recursive: true })
    const root = await mkdtemp(join(tmp, "blob-cli-nitro-"))
    const server = await (async () => {
      await mkdir(join(root, "server", "routes"), { recursive: true })
      await writeFile(join(root, "package.json"), "{\"name\":\"blob-cli-nitro\",\"private\":true,\"type\":\"module\"}\n")
      await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
      await writeFile(join(root, "input.bin"), binary)
      return await createServer({
        appType: "custom",
        configFile: false,
        logLevel: "silent",
        plugins: [hubBlob({ base: join(root, ".data", "blob"), driver: "fs" }), nitro() as never],
        root,
        server: { middlewareMode: true, ws: false },
      })
    })()
    try {
      const fetch = (input: string | URL | Request, init?: RequestInit) => viaMiddlewares(server.middlewares, input, init)
      const run = async (args: string[]) => {
        const stdout = stream()
        const stderr = stream()
        const code = await runBlobCli(args, { cwd: root, env: {}, rootDir: root, stderr, stdout }, { fetch })
        return { bytes: stdout.bytes(), code, stderr: stderr.output(), stdout: stdout.output() }
      }

      const discovery = await fetch(`http://localhost:5173${blobDevRoute}`, { headers: { "x-vitehub-blob-dev": "1" } })
      expect(await discovery.json()).toMatchObject({ runtime: "nitro" })

      expect(await run(["put", "files/all.bin", "input.bin", "--content-type", "application/octet-stream"])).toMatchObject({
        code: 0,
        stderr: "",
        stdout: "Created blob files/all.bin in store default (256 B, application/octet-stream).\n",
      })
      expect(await run(["get", "files/all.bin", "--output", "output.bin"])).toMatchObject({ code: 0, stderr: "" })
      expect(new Uint8Array(await readFile(join(root, "output.bin")))).toEqual(binary)
      const piped = await run(["get", "files/all.bin"])
      expect(piped.code).toBe(0)
      expect(Buffer.concat(piped.bytes)).toEqual(Buffer.from(binary))
      expect(await run(["list", "--json"])).toMatchObject({ code: 0, stdout: expect.stringContaining("\"files/all.bin\"") })
      expect(await run(["head", "files/all.bin", "--json"])).toMatchObject({ code: 0, stdout: expect.stringContaining("\"size\": 256") })
      expect(await run(["del", "files/all.bin"])).toEqual({ bytes: [], code: 0, stderr: "", stdout: "Deleted blob files/all.bin from store default.\n" })
      expect(await run(["head", "files/all.bin"])).toMatchObject({ code: 1, stderr: "Blob files/all.bin was not found in store default.\n" })
    }
    finally {
      await server.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)
})
