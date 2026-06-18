import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createAgentCliContributor, runAgentDevCli, runAgentEvalCli } from "../src/cli.ts"
import { createAgentEvaliteConfigPath, writeAgentEvaliteConfig } from "../src/internal/evalite-config.ts"
import { agentInvocationStreamHeader, agentInvocationStreamHeaderValue } from "../src/invocation-stream.ts"

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

function ndjson(events: unknown[]): Response {
  return new Response(`${events.map(event => JSON.stringify(event)).join("\n")}\n`, {
    headers: { "content-type": "application/x-ndjson" },
  })
}

describe("agent CLI", () => {
  it("contributes the agent eval feature", () => {
    expect(createAgentCliContributor()).toEqual({
      namespaces: [{
        description: "Agent development workflows.",
        features: [
          expect.objectContaining({ name: "eval" }),
          expect.objectContaining({ name: "dev" }),
        ],
        name: "agent",
      }],
    })
  })

  it("keeps the agent dev feature when eval is disabled", () => {
    expect(createAgentCliContributor({ eval: false })).toEqual({
      namespaces: [{
        description: "Agent development workflows.",
        features: [expect.objectContaining({ name: "dev" })],
        name: "agent",
      }],
    })
  })

  it("streams a one-shot Agent Dev Loop message through the Vite endpoint", async () => {
    const stdout = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", trigger: "chat.message", type: "start" },
          { text: "hello from agent", type: "text-delta" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["hello", "agent"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout,
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toBe("hello from agent\n")
    expect(fetchAgentStream).toHaveBeenCalledTimes(2)
    const [get, post] = fetchAgentStream.mock.calls
    expect(get?.[1]?.headers).toMatchObject({
      accept: "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    expect(post?.[1]?.headers).toMatchObject({
      "content-type": "application/json",
      [agentInvocationStreamHeader]: agentInvocationStreamHeaderValue,
    })
    expect(post?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      agent: "support",
      messages: [{
        parts: [{ text: "hello agent", type: "text" }],
        role: "user",
      }],
    })
  })

  it("surfaces Agent Dev Loop approval requests", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", trigger: "chat.message", type: "start" },
          { id: "approval-1", name: "workspace_write", reason: "Needs write access.", type: "approval-request" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "support", triggers: ["chat.message"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["hello"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(1)
    expect(stderr.output()).toContain("[approval required] workspace_write: Needs write access.")
  })

  it("runs Evalite through the Node runner with ViteHub defaults", async () => {
    const runner = vi.fn(async () => ({ exitCode: undefined }))
    const exitCode = await runAgentEvalCli(["server/agents/support.eval.ts"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout: stream(),
    }, undefined, runner, vi.fn(async () => "/repo/.vitehub/agent/evalite.config.ts"))

    expect(exitCode).toBe(0)
    expect(runner).toHaveBeenCalledWith({
      cache: undefined,
      cacheEnabled: undefined,
      cwd: "/repo",
      forceRerunTriggers: [
        "server/agents/**",
        "src/**/*.agent.*",
        "src/**/*.eval.*",
      ],
      hideTable: undefined,
      maxConcurrency: undefined,
      mode: "run-once-and-exit",
      outputPath: undefined,
      path: "server/agents/support.eval.ts",
      scoreThreshold: undefined,
      server: undefined,
      setupFiles: undefined,
      testTimeout: undefined,
      trialCount: undefined,
    })
  })

  it("passes supported Evalite runner options exactly", async () => {
    const runner = vi.fn(async () => ({ exitCode: undefined }))
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
    }, {
      forceRerunTriggers: ["server/agents/support/**"],
      maxConcurrency: 1,
      testTimeout: 300000,
    }, runner, vi.fn(async () => "/repo/.vitehub/agent/evalite.config.ts"))

    expect(exitCode).toBe(0)
    expect(runner).toHaveBeenCalledWith({
      cache: undefined,
      cacheEnabled: false,
      cwd: "/repo",
      forceRerunTriggers: ["server/agents/support/**"],
      hideTable: true,
      maxConcurrency: 1,
      mode: "watch-for-file-changes",
      outputPath: "eval-results.json",
      path: "server/agents/support.eval.ts",
      scoreThreshold: 85,
      server: undefined,
      setupFiles: undefined,
      testTimeout: 300000,
      trialCount: undefined,
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
    }, undefined, runner, vi.fn(async () => "/repo/.vitehub/agent/evalite.config.ts"))

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
    }, false, vi.fn())

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
    }, undefined, runner, vi.fn(async () => "/repo/.vitehub/agent/evalite.config.ts"))

    expect(exitCode).toBe(1)
    expect(runner).not.toHaveBeenCalled()
    expect(stderr.output()).toContain("Unknown option: --config")
  })

  it("writes generated Evalite config under .vitehub/agent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-eval-"))
    try {
      await writeAgentEvaliteConfig(rootDir, {
        forceRerunTriggers: ["server/agents/support/**"],
        maxConcurrency: 1,
        testTimeout: 300000,
      })

      await expect(readFile(createAgentEvaliteConfigPath(rootDir), "utf8")).resolves.toContain(`"maxConcurrency": 1`)
      await expect(readFile(createAgentEvaliteConfigPath(rootDir), "utf8")).resolves.toContain(`"testTimeout": 300000`)
      await expect(readFile(createAgentEvaliteConfigPath(rootDir), "utf8")).resolves.toContain(`"server/agents/support/**"`)
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })
})
