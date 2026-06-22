import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
          { agent: "support", metadata: {}, trigger: "chat.message", type: "start" },
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

    const exitCode = await runAgentDevCli(["-p", "hello agent"], {
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

  it("accepts Agent Dev Loop discovery aliases", async () => {
    const stdout = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "review", type: "start" },
          { text: "summary", type: "text-delta" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ aliases: ["summary"], name: "review", triggers: ["github.webhook"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["--agent", "summary", "-p", "/summary"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr: stream(),
      stdout,
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stdout.output()).toBe("summary\n")
    const post = fetchAgentStream.mock.calls[1]
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      agent: "summary",
    })
  })

  it("renders and clears the default Agent Dev Loop thinking fallback", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", trigger: "chat.message", type: "start" },
          { text: "done", type: "text-delta" },
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

    expect(exitCode).toBe(0)
    expect(stderr.output()).toBe("\u001B[?25l\rThinking...\r\u001b[K\u001B[?25h")
  })

  it("uses Agent Dev Loop thinking fallback metadata", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", metadata: { thinkingFallback: "Reading PR..." }, trigger: "chat.message", type: "start" },
          { id: "tool-1", input: { command: "ls" }, name: "workspaceShell", type: "tool-call" },
          { text: "done", type: "text-delta" },
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

    expect(exitCode).toBe(0)
    expect(stderr.output()).toContain("\u001B[?25l\rReading PR...\r\u001b[K\u001B[?25h")
    expect(stderr.output()).toContain("[tool] ls")
    expect(stderr.output()).not.toContain("Thinking...")
  })

  it("respects disabled Agent Dev Loop thinking fallback metadata", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", metadata: { thinkingFallback: null }, trigger: "chat.message", type: "start" },
          { text: "done", type: "text-delta" },
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

    expect(exitCode).toBe(0)
    expect(stderr.output()).toBe("")
  })

  it("loads Agent Invocation Context Values from a JSON file", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-context-"))
    const rootDir = join(workspaceDir, "app")
    await mkdir(rootDir)
    try {
      const contextPath = join(rootDir, "context.json")
      await writeFile(contextPath, JSON.stringify({
        pullRequest: {
          repository: "acme/repo",
          trigger: { command: "/summary" },
        },
      }), "utf8")
      const stdout = stream()
      const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return ndjson([
            { agent: "review", trigger: "github.webhook", type: "start" },
            { text: "summary", type: "text-delta" },
            { type: "finish" },
            { type: "done" },
          ])
        }
        return Response.json({
          agents: [{ name: "review", triggers: ["chat.message"] }],
          root: rootDir,
        })
      })

      const exitCode = await runAgentDevCli(["--agent", "review", "--context", "context.json", "--prompt=/summary"], {
        cwd: workspaceDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr: stream(),
        stdout,
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(0)
      expect(stdout.output()).toBe(`Loaded context: ${contextPath}\nsummary\n`)
      const post = fetchAgentStream.mock.calls.find(([, init]) => init?.method === "POST")
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
        agent: "review",
        context: {
          pullRequest: {
            repository: "acme/repo",
            trigger: { command: "/summary" },
          },
        },
        messages: [{
          parts: [{ text: "/summary", type: "text" }],
          role: "user",
        }],
      })
    }
    finally {
      await rm(workspaceDir, { force: true, recursive: true })
    }
  })

  it("rejects non-object Agent Dev Loop context files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-agent-dev-context-"))
    try {
      await writeFile(join(rootDir, "context.json"), "[1,2,3]", "utf8")
      const stderr = stream()
      const fetchAgentStream = vi.fn()
      const exitCode = await runAgentDevCli(["--context", "context.json", "hello"], {
        cwd: rootDir,
        env: {},
        rootDir,
        spawn: vi.fn(),
        stderr,
        stdout: stream(),
      }, { fetch: fetchAgentStream as never })

      expect(exitCode).toBe(1)
      expect(fetchAgentStream).not.toHaveBeenCalled()
      expect(stderr.output()).toContain("Agent Dev Loop context file must contain a JSON object.")
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
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

  it("renders Agent Dev Loop tool output and final usage note", async () => {
    const stderr = stream()
    const stdout = stream()
    const longOutput = "x".repeat(1300)
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "support", trigger: "chat.message", type: "start" },
          { id: "tool-1", name: "shell", type: "tool-input-start" },
          { id: "tool-1", input: { command: "cat file.md" }, name: "shell", type: "tool-call" },
          { id: "tool-1", name: "shell", output: { command: "cat file.md", exitCode: 0, stderr: "", stdout: longOutput }, type: "tool-result" },
          { id: "tool-2", name: "workspace_list", output: { path: "." }, type: "tool-result" },
          { text: "done", type: "text-delta" },
          { type: "usage", usageRecord: { cost: { amount: "0.00000400", currency: "USD", estimated: true, source: "estimated" }, latency: { durationMs: 2000, tokensPerSecond: 3.5 }, usage: { inputTokens: 10, outputTokenDetails: { reasoningTokens: 3 }, outputTokens: 7, totalTokens: 17 } } },
          { type: "usage", usageRecord: { cost: { amount: "0.00000400", currency: "USD", estimated: true, source: "estimated" }, latency: { durationMs: 2000, tokensPerSecond: 3.5 }, usage: { inputTokens: 10, outputTokenDetails: { reasoningTokens: 3 }, outputTokens: 7, totalTokens: 17 } } },
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
      stdout,
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toContain("[tool] cat file.md")
    expect(stderr.output()).not.toContain(`input: {"command":"cat file.md"}`)
    expect(stderr.output()).toContain("[truncated ")
    expect(stderr.output()).not.toContain(longOutput)
    expect(stderr.output()).toContain("---")
    expect(stderr.output()).toContain("[tool] workspace_list")
    expect(stderr.output()).toContain(`output: {"path":"."}`)
    expect(stderr.output()).not.toContain("[usage]")
    expect(stderr.output().match(/\[tool\] cat file\.md/g)).toHaveLength(1)
    expect(stdout.output()).toContain("done\n\n> [!NOTE]\n> Usage: cost ~$0.000004; 17 tokens: 10 in / 7 out; 3 reasoning tokens; time 2.0s; speed 3.5 tok/s")
  })

  it("renders Agent Dev Loop delivery previews", async () => {
    const stderr = stream()
    const fetchAgentStream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ndjson([
          { agent: "review", trigger: "github.webhook", type: "start" },
          { text: "summary", type: "text-delta" },
          { channelId: "github", effect: { kind: "reply", payload: "summary" }, type: "delivery-preview" },
          { type: "finish" },
          { type: "done" },
        ])
      }
      return Response.json({
        agents: [{ name: "review", triggers: ["github.webhook"] }],
        root: "/repo",
      })
    })

    const exitCode = await runAgentDevCli(["--agent", "review", "--trigger", "github.webhook", "--input", "{}"], {
      cwd: "/repo",
      env: {},
      rootDir: "/repo",
      spawn: vi.fn(),
      stderr,
      stdout: stream(),
    }, { fetch: fetchAgentStream as never })

    expect(exitCode).toBe(0)
    expect(stderr.output()).toContain("[delivery preview] would reply on github")
    expect(stderr.output()).toContain("payload: summary")
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
