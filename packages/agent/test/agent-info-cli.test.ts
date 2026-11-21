import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writeViteHubDevServerFile } from "@vite-hub/internal/cli"
import { describe, expect, it, vi } from "vitest"

import { runAgentInfoCli } from "../src/internal/agent-info-cli.ts"

function stream() {
  let output = ""
  return { get output() { return output }, write: (chunk: string | Uint8Array) => { output += String(chunk) } }
}

describe("agent get CLI", () => {
  it("rejects an empty inline development server URL as a missing value", async () => {
    const stderr = stream()
    const stdout = stream()
    const exitCode = await runAgentInfoCli(["--url="], {
      env: {},
      fetch: vi.fn(),
      rootDir: "/app",
      stderr,
      stdout,
    })

    expect(exitCode).toBe(1)
    expect(stderr.output).toContain("Missing value for --url=.")
    expect(stdout.output).toContain("Usage: vitehub agent get")
  })

  it("inspects the dev server that runs in the project without --url", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-info-"))
    try {
      // `nuxt dev --port 4731` records its URL in the project root. The CLI runs from Nuxt's Vite root, `app/`.
      await writeFile(join(rootDir, "nuxt.config.ts"), "export default {}\n")
      await mkdir(join(rootDir, "app"))
      writeViteHubDevServerFile(rootDir, { root: rootDir, url: "http://127.0.0.1:4731/" })
      const fetchAgentInfo = vi.fn(async () => Response.json({ inspection: { name: "docs" }, root: join(rootDir, "app") }))
      const exitCode = await runAgentInfoCli(["docs"], {
        env: { VITEHUB_DEV_SERVER_URL: "http://localhost:5173" },
        rootDir: join(rootDir, "app"),
        stderr: stream(),
        stdout: stream(),
      }, { fetch: fetchAgentInfo as never })

      expect(exitCode).toBe(0)
      expect(fetchAgentInfo).toHaveBeenCalledWith("http://127.0.0.1:4731/__vitehub/agent/invocation-stream?inspect=1&agent=docs", expect.anything())
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("takes the Agent name as an argument and names it for the removed --agent", async () => {
    const stderr = stream()
    expect(await runAgentInfoCli(["--agent", "docs"], { env: {}, rootDir: "/app", stderr, stdout: stream() })).toBe(1)
    expect(stderr.output).toContain("--agent is now the name argument. Run vitehub agent get docs.")
  })

  it("does not fetch a guessed URL when the project has no dev server", async () => {
    const stderr = stream()
    const fetch = vi.fn<typeof globalThis.fetch>()
    expect(await runAgentInfoCli(["docs"], { env: {}, rootDir: "/app", stderr, stdout: stream() }, { fetch })).toBe(1)
    expect(stderr.output).toContain("INTERNAL_DEV_SERVER_NOT_FOUND")
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["https://app.example.com", "http://localhost:3000"])("reads the Console at %s through status.get", async (app) => {
    const stdout = stream()
    const calls: string[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as { i: string, m: string, a: unknown[] }
      calls.push(`${String(url)} ${call.m} ${JSON.stringify(call.a)}`)
      return Response.json({ i: call.i, r: { agent: "docs", ready: true }, t: "s" })
    })
    expect(await runAgentInfoCli(["docs", "--url", app], { env: {}, rootDir: "/app", stderr: stream(), stdout }, { fetch: fetch as never })).toBe(0)
    expect(calls).toEqual([`${app}/_vitehub/rpc status.get [{"agent":"docs"}]`])
    expect(JSON.parse(stdout.output)).toEqual({ agent: "docs", ready: true })
  })

  it("selects the Dev Loop explicitly on a custom hostname", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ inspection: { name: "docs" }, root: "/app" }))
    expect(await runAgentInfoCli(["docs", "--dev", "--url=https://dev.example.com"], { env: {}, rootDir: "/app", stderr: stream(), stdout: stream() }, { fetch })).toBe(0)
    expect(fetch).toHaveBeenCalledWith("https://dev.example.com/__vitehub/agent/invocation-stream?inspect=1&agent=docs", expect.anything())
  })
})
