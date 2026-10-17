import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"

import { describe, expect, it } from "vitest"
import { createServer } from "vite"

import { runScheduleCli } from "../src/cli.ts"
import { hubSchedule } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"

function stream() {
  let value = ""
  return { output: () => value, write: (chunk: string | Uint8Array) => { value += String(chunk); return true } }
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

describe("vitehub schedule run against a Vite + Nitro Development Server", () => {
  it("runs a Static Schedule inside the Nitro runtime and records the run", async () => {
    // SAFETY: Nitro publishes this Vite plugin at the runtime-resolved `nitro/vite` entry.
    const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
    // Nitro writes its dev worker with relative imports, so the app root stays inside the workspace and resolves packages normally.
    const tmp = resolve(import.meta.dirname, "../.vitest-tmp")
    await mkdir(tmp, { recursive: true })
    const root = await mkdtemp(join(tmp, "schedule-run-nitro-"))
    await mkdir(join(root, "server", "schedules"), { recursive: true })
    await mkdir(join(root, "server", "routes"), { recursive: true })
    await writeFile(join(root, "package.json"), "{\"name\":\"schedule-run-nitro\",\"private\":true,\"type\":\"module\"}\n")
    await writeFile(join(root, "server", "routes", "index.ts"), "export default () => 'ok'\n")
    // Only a Nitro plugin sets this value, so the handler fails when it runs outside the Nitro runtime.
    await writeFile(join(root, "server", "marker.ts"), "export default () => { (globalThis as { scheduleRunMarker?: string }).scheduleRunMarker = 'nitro' }\n")
    await writeFile(join(root, "server", "schedules", "sync.ts"), [
      "import { defineSchedule } from '@vite-hub/schedule'",
      "",
      "export default defineSchedule('0 9 * * *', () => {",
      "  if ((globalThis as { scheduleRunMarker?: string }).scheduleRunMarker !== 'nitro') throw new Error('The Nitro plugin did not run.')",
      "}, { manual: true })",
      "",
    ].join("\n"))
    await writeFile(join(root, "server", "schedules", "locked.ts"), "import { defineSchedule } from '@vite-hub/schedule'\n\nexport default defineSchedule('0 9 * * *', () => {})\n")
    const server = await createServer({
      appType: "custom",
      configFile: false,
      logLevel: "silent",
      // SAFETY: `nitro` is the user Nitro config that `nitro/vite` reads from the Vite config.
      ...({ nitro: { plugins: [join(root, "server", "marker.ts")] } } as object),
      plugins: [hubSchedule(), nitro() as never],
      root,
      server: { middlewareMode: true, ws: false },
    })
    try {
      const fetch = (input: string | URL | Request, init?: RequestInit) => viaMiddlewares(server.middlewares, input, init)
      const run = async (args: string[]) => {
        const stdout = stream()
        const stderr = stream()
        const code = await runScheduleCli(args, { cwd: root, env: {}, rootDir: root, stderr, stdout }, { fetch })
        return { code, stderr: stderr.output(), stdout: stdout.output() }
      }

      const succeeded = await run(["run", "sync", "--json"])
      expect(succeeded).toMatchObject({ code: 0, stderr: "" })
      const record = JSON.parse(succeeded.stdout) as { id: string }
      expect(record).toMatchObject({ id: expect.stringMatching(/^srun_manual_sync_/), scheduleId: "sync", status: "succeeded" })

      const runs = await run(["runs", "sync", "--json"])
      expect(runs.code).toBe(0)
      expect(JSON.parse(runs.stdout)).toMatchObject({ runs: [{ id: record.id, status: "succeeded" }] })

      const locked = await run(["run", "locked"])
      expect(locked).toMatchObject({ code: 1, stderr: expect.stringContaining("HTTP 403") })
    }
    finally {
      await server.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 120_000)
})
