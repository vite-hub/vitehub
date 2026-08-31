import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
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
