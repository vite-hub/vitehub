import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const drainEntrypoint = fileURLToPath(new URL("../src/drain.ts", import.meta.url))

describe("vitehub-drain", () => {
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
    const command = spawn(process.execPath, [
      drainEntrypoint,
      String(target.pid),
      `http://127.0.0.1:${port}`,
    ])
    const [code] = await once(command, "exit")

    expect(code).toBe(1)
  })

  it.each(["../src/drain.ts", "../dist/drain.js"])("releases an unfinished error response before retrying through %s", async (entry) => {
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
      const result = await execFileAsync(process.execPath, [
        fileURLToPath(new URL(entry, import.meta.url)),
        String(process.pid),
        `http://127.0.0.1:${address.port}`,
      ], { timeout: 8_000 })

      expect(result).toMatchObject({ stdout: "", stderr: "" })
      expect(requests).toBe(2)
      expect(closedBeforeRetry).toBe(true)
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it.each(["-h", "--help"])("prints help for %s", async (argument) => {
    await expect(execFileAsync(process.execPath, [drainEntrypoint, argument])).resolves.toEqual(expect.objectContaining({
      stderr: "",
      stdout: "Usage: vitehub-drain MAINPID [STATUS_URL]\n",
    }))
  })

  it("keeps invalid PID arguments as usage errors", async () => {
    await expect(execFileAsync(process.execPath, [drainEntrypoint, "invalid"])).rejects.toMatchObject({
      code: 2,
      stderr: "usage: vitehub-drain MAINPID [STATUS_URL]\n",
      stdout: "",
    })
  })
})
