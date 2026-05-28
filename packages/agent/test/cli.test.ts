import { describe, expect, it, vi } from "vitest"

import { createAgentCliContributor, runAgentEvalCli } from "../src/cli.ts"

function stream() {
  let value = ""
  return {
    output: () => value,
    write(chunk: string | Uint8Array) {
      value += String(chunk)
      return true
    },
  }
}

describe("agent CLI", () => {
  it("contributes the agent eval feature", () => {
    expect(createAgentCliContributor()).toEqual({
      namespaces: [{
        description: "Agent development workflows.",
        features: [expect.objectContaining({ name: "eval" })],
        name: "agent",
      }],
    })
  })

  it("runs Evalite through the Node runner with ViteHub defaults", async () => {
    const runner = vi.fn(async () => ({ vitest: {} as never }))
    const exitCode = await runAgentEvalCli(["server/agents/support.eval.ts"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout: stream(),
    }, undefined, runner)

    expect(exitCode).toBe(0)
    expect(runner).toHaveBeenCalledWith({
      cacheEnabled: undefined,
      cwd: "/repo",
      forceRerunTriggers: [
        "server/agents/**",
        "src/**/*.agent.*",
        "src/**/*.eval.*",
      ],
      hideTable: undefined,
      mode: "run-once-and-exit",
      outputPath: undefined,
      path: "server/agents/support.eval.ts",
      scoreThreshold: undefined,
    })
  })

  it("passes supported Evalite runner options exactly", async () => {
    const runner = vi.fn(async () => ({ vitest: {} as never }))
    const exitCode = await runAgentEvalCli([
      "watch",
      "server/agents/support.eval.ts",
      "--threshold",
      "85",
      "--output",
      "eval-results.json",
      "--hide-table",
      "--no-cache",
    ], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout: stream(),
    }, { eval: { forceRerunTriggers: ["server/agents/support/**"] } }, runner)

    expect(exitCode).toBe(0)
    expect(runner).toHaveBeenCalledWith({
      cacheEnabled: false,
      cwd: "/repo",
      forceRerunTriggers: ["server/agents/support/**"],
      hideTable: true,
      mode: "watch-for-file-changes",
      outputPath: "eval-results.json",
      path: "server/agents/support.eval.ts",
      scoreThreshold: 85,
    })
  })

  it("prints help without spawning Evalite", async () => {
    const stdout = stream()
    const runner = vi.fn()
    const exitCode = await runAgentEvalCli(["--help"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout,
    }, undefined, runner)

    expect(exitCode).toBe(0)
    expect(runner).not.toHaveBeenCalled()
    expect(stdout.output()).toContain("Usage: vitehub agent eval")
  })

  it("can disable agent eval CLI", async () => {
    const stderr = stream()
    const exitCode = await runAgentEvalCli([], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, { eval: false }, vi.fn())

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("disabled")
  })

  it("rejects unsupported options before running Evalite", async () => {
    const stderr = stream()
    const runner = vi.fn()
    const exitCode = await runAgentEvalCli(["--config", "evalite.config.ts"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, undefined, runner)

    expect(exitCode).toBe(1)
    expect(runner).not.toHaveBeenCalled()
    expect(stderr.output()).toContain("Unknown option: --config")
  })
})
