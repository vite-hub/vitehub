import { execFile } from "node:child_process"
import { once } from "node:events"
import { createServer as createPortServer } from "node:net"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, resolveConfig, type ViteDevServer } from "vite"

import { runAgentDevCli, runAgentInfoCli } from "@vite-hub/agent/cli"

const execFileAsync = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "../../..")
const exampleRoot = resolve(import.meta.dirname, "../examples/vite")

function outputStream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += chunk.toString()
    },
  }
}

async function availablePort() {
  const server = createPortServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const address = server.address()
  if (!(address instanceof Object)) throw new Error("Could not allocate an Agent example test port")

  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

describe("offline Agent Vite example", () => {
  let server: ViteDevServer | undefined
  let url = ""

  beforeAll(async () => {
    await execFileAsync(resolve(repoRoot, "node_modules/.bin/vp"), ["build"], { cwd: exampleRoot })

    const port = await availablePort()
    server = await createServer({
      configFile: join(exampleRoot, "vite.config.ts"),
      logLevel: "silent",
      root: exampleRoot,
      server: { host: "127.0.0.1", port, strictPort: true },
    })
    await server.listen()
    url = `http://127.0.0.1:${port}`
  }, 30_000)

  afterAll(async () => {
    await server?.close()
  })

  it("keeps the documented CLI URL pinned to the development port", async () => {
    const config = await resolveConfig({ configFile: join(exampleRoot, "vite.config.ts"), root: exampleRoot }, "serve")

    expect(config.server.strictPort).toBe(true)
  })

  it("builds a request route from public package imports", async () => {
    const moduleUrl = pathToFileURL(join(exampleRoot, "dist/server.js")).href
    // SAFETY: the example build emits its default H3 app from src/server.ts.
    const { default: app } = await import(moduleUrl) as { default: { request: (path: string, init?: RequestInit) => Promise<Response> } }
    const response = await app.request("/greet", {
      body: JSON.stringify({ name: "Ada" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      text: "Hello, Ada. This Agent ran without credentials.",
    })
  })

  it("discovers and invokes the Agent through the public CLI contract", async () => {
    const infoStdout = outputStream()
    const infoStderr = outputStream()
    const context = {
      cwd: exampleRoot,
      env: {},
      rootDir: exampleRoot,
      stderr: infoStderr,
      stdout: infoStdout,
    }

    expect(await runAgentInfoCli(["--agent", "greeting", "--json", "--url", url], context)).toBe(0)
    expect(infoStderr.output()).toBe("")
    expect(JSON.parse(infoStdout.output())).toMatchObject({
      config: { driver: { kind: "run" } },
      name: "greeting",
    })

    const devStdout = outputStream()
    const devStderr = outputStream()
    expect(await runAgentDevCli(["--agent", "greeting", "--prompt", "Ada", "--url", url], {
      ...context,
      stderr: devStderr,
      stdout: devStdout,
    })).toBe(0)
    expect(devStdout.output()).toBe("Hello, Ada. This Agent ran without credentials.\n")
  })

  it("reports an unknown discovered Agent", async () => {
    const stderr = outputStream()
    const exitCode = await runAgentDevCli(["--agent", "missing", "--prompt", "Ada", "--url", url], {
      cwd: exampleRoot,
      env: {},
      rootDir: exampleRoot,
      stderr,
      stdout: outputStream(),
    })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("Unknown Agent Dev Loop Target: missing")
  })
})
