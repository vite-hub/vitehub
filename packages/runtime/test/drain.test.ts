import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"

import { describe, expect, it } from "vitest"

import { runDrain } from "../src/internal/drain.ts"

function output() {
  const streams = { stderr: "", stdout: "" }
  return {
    streams,
    stderr: { write: (chunk: string) => { streams.stderr += chunk } },
    stdout: { write: (chunk: string) => { streams.stdout += chunk } },
  }
}

describe("vitehub drain", () => {
  it("rejects when signal delivery terminates a target without completing drain", async () => {
    const target = spawn(process.execPath, ["-e", `
      const { createServer } = require("node:http")
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ status: "accepting" }))
      })
      server.listen(0, "127.0.0.1", () => process.send(server.address().port))
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    // SAFETY: The child sends exactly one numeric listening port from its listen callback.
    const [port] = await once(target, "message") as [number]
    const code = await runDrain([String(target.pid), `http://127.0.0.1:${port}`], output())

    expect(code).toBe(1)
  })

  it("releases an unfinished error response before retrying", async () => {
    let requests = 0
    let errorBodyClosed = false
    let closedBeforeRetry = false
    const server = createServer((_request, response) => {
      requests += 1
      if (requests === 1) {
        response.once("close", () => { errorBodyClosed = true })
        response.writeHead(503, { "content-type": "text/plain" })
        response.write("temporarily unavailable")
        return
      }
      closedBeforeRetry = errorBodyClosed
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ status: "drained" }))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Expected a listening TCP server")
      const io = output()
      const code = await runDrain([String(process.pid), `http://127.0.0.1:${address.port}`], io)

      expect(code).toBe(0)
      expect(io.streams).toEqual({ stderr: "", stdout: "" })
      expect(requests).toBe(2)
      expect(closedBeforeRetry).toBe(true)
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it.each(["-h", "--help"])("prints help for %s", async (argument) => {
    const io = output()
    await expect(runDrain([argument], io)).resolves.toBe(0)
    expect(io.streams).toEqual({ stderr: "", stdout: "Usage: vitehub drain MAINPID [STATUS_URL]\n" })
  })

  it("keeps invalid PID arguments as usage errors", async () => {
    const io = output()
    await expect(runDrain(["invalid"], io)).resolves.toBe(2)
    expect(io.streams).toEqual({ stderr: "usage: vitehub drain MAINPID [STATUS_URL]\n", stdout: "" })
  })
})
