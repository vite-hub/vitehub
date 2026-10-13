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
})
