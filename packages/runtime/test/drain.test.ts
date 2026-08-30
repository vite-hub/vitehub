import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("process drain command", () => {
  it("rejects when signal delivery terminates a target without completing drain", async () => {
    const target = spawn(process.execPath, ["-e", `
      const { createServer } = require("node:http")
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ status: "accepting" }))
      })
      server.listen(0, "127.0.0.1", () => process.send(server.address().port))
    `], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const [port] = await once(target, "message") as [number]
    const command = spawn(process.execPath, [
      fileURLToPath(new URL("../src/drain.ts", import.meta.url)),
      String(target.pid),
      `http://127.0.0.1:${port}`,
    ])
    const [code] = await once(command, "exit")

    expect(code).toBe(1)
  })
})
