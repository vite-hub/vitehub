import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import { runAgentInfoCli } from "../src/internal/agent-info-cli.ts"
import { runAgentChannelReplayCli } from "../src/internal/channel-replay-cli.ts"
import { hubAgent } from "../src/vite.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Connect } from "vite"

function stream() {
  let output = ""
  return { get output() { return output }, write: (chunk: string | Uint8Array) => { output += String(chunk) } }
}

/** Sends a CLI `fetch` through the dev server middlewares, as Vite would. */
function middlewareFetch(handlers: Connect.NextHandleFunction[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    const req = Readable.from([]) as IncomingMessage
    req.headers = { host: url.host, ...Object.fromEntries(Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)])) }
    req.method = init?.method ?? "GET"
    req.url = `${url.pathname}${url.search}`
    return await new Promise<Response>((resolve, reject) => {
      let body = ""
      let status = 200
      const res = {
        destroyed: false,
        end(chunk?: unknown) {
          if (chunk) body += Buffer.from(chunk as Uint8Array).toString("utf8")
          resolve(new Response(body, { status }))
        },
        get statusCode() { return status },
        set statusCode(value: number) { status = value },
        headersSent: false,
        off: vi.fn(),
        once: vi.fn(),
        setHeader: vi.fn(),
        write(chunk: unknown) {
          body += Buffer.from(chunk as Uint8Array).toString("utf8")
          return true
        },
      } as unknown as ServerResponse
      let index = 0
      const next = (error?: unknown) => {
        if (error) return reject(error)
        const handler = handlers[index++]
        if (!handler) return resolve(new Response("Not found.", { status: 404 }))
        handler(req, res, next)
      }
      next()
    })
  }
}

describe("Dev Loop commands with a broken Agent module", () => {
  it("print the load error instead of a token or server error", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-agent-info-load-error-"))
    try {
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "support.ts"), "export default {}\n")
      const handlers: Connect.NextHandleFunction[] = []
      const server = {
        config: { root, server: { port: 3000 } },
        middlewares: { use: (handler: Connect.NextHandleFunction) => { handlers.push(handler) } },
        resolvedUrls: { local: ["http://localhost:3000/"] },
        ssrLoadModule: async () => { throw new Error("Cannot find package 'missing-sdk' imported from server/agents/support.ts") },
      }
      const plugin = hubAgent()
      if (typeof plugin.configResolved === "function") {
        await plugin.configResolved.call({} as never, { command: "serve", root, server: { port: 3000 } } as never)
      }
      const configureServer = plugin.configureServer
      await (typeof configureServer === "function" ? configureServer : configureServer!.handler).call({} as never, server as never)

      const stderr = stream()
      const exitCode = await runAgentInfoCli(["--url", "http://localhost:3000"], { env: {}, rootDir: root, stderr, stdout: stream() }, { fetch: middlewareFetch(handlers) })

      expect(exitCode).toBe(1)
      expect(stderr.output).toContain("AGENT_DEV_LOOP_FAILED")
      expect(stderr.output).toContain("Cannot find package 'missing-sdk' imported from server/agents/support.ts")
      expect(stderr.output).not.toContain("Forbidden Agent Dev Loop token")

      const replayStderr = stream()
      const replayExitCode = await runAgentChannelReplayCli(["--agent", "support", "--channel", "gmail"], { env: { VITEHUB_DEV_SERVER_URL: "http://localhost:3000" }, rootDir: root, stderr: replayStderr, stdout: stream() }, { fetch: middlewareFetch(handlers) })
      expect(replayExitCode).toBe(1)
      expect(replayStderr.output).toContain("Cannot find package 'missing-sdk' imported from server/agents/support.ts")
      expect(replayStderr.output).not.toContain("No Compatible Vite Development Server")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
