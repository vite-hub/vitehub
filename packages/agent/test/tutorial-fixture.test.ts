import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { promisify } from "node:util"

import { describe, expect, it, vi } from "vitest"
import { createMemo } from "../../../fixtures/tutorials/agents/src/memo.ts"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "../../..")
const fixtureRoot = resolve(repoRoot, "fixtures/tutorials/agents")

async function availablePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a tutorial test port")

  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function requestWhenReady(url: string) {
  let lastError: unknown

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await fetch(url, {
        body: JSON.stringify({ name: "Ada" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    }
    catch (error) {
      lastError = error
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }

  throw lastError
}

describe("Agents launch tutorial fixture", () => {
  it("memoizes values by key for one invocation", () => {
    const create = vi.fn(() => ({ ready: true }))
    const memo = createMemo()

    expect(memo("resource", create)).toBe(memo("resource", create))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("builds and runs the documented server", async () => {
    await execFileAsync(resolve(repoRoot, "node_modules/.bin/vp"), ["build"], { cwd: fixtureRoot })

    const port = await availablePort()
    const child = spawn(process.execPath, ["dist/server.js"], {
      cwd: fixtureRoot,
      env: { ...process.env, PORT: String(port) },
      stdio: "ignore",
    })
    const exited = once(child, "exit")

    try {
      const response = await requestWhenReady(`http://127.0.0.1:${port}/greet`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        text: "Hello, Ada. This result came from an Agent Invocation.",
      })
    }
    finally {
      child.kill()
      await exited
    }
  }, 30_000)
})
