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

describe("agent info CLI", () => {
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
    expect(stdout.output).toContain("Usage: vitehub agent info")
  })

  it("inspects the dev server that runs in the project without --url", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-info-"))
    try {
      // `nuxt dev --port 4731` records its URL in the project root. The CLI runs from Nuxt's Vite root, `app/`.
      await writeFile(join(rootDir, "nuxt.config.ts"), "export default {}\n")
      await mkdir(join(rootDir, "app"))
      writeViteHubDevServerFile(rootDir, { root: rootDir, url: "http://127.0.0.1:4731/" })
      const fetchAgentInfo = vi.fn(async () => Response.json({ inspection: { name: "docs" }, root: join(rootDir, "app") }))
      const exitCode = await runAgentInfoCli(["--agent", "docs"], {
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
})
