import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { agentDiagnostics } from "../src/agent-diagnostics.ts"
import { installChannelsConsoleHost } from "../src/channels-console-host.ts"
import { agentHttpError, toHttpErrorResponse } from "../src/http-error.ts"
import { runConversationsExportCli } from "../src/internal/conversations-cli.ts"
import { agentChannelOperations } from "../src/operations.ts"

import type { OperationContext } from "@vite-hub/internal/operations"

// The codes that replace the Agent error classes.
const codes = [
  "AGENT_CONVERSATIONS_EXPORT_ARGUMENTS_INVALID",
  "AGENT_CONVERSATIONS_EXPORT_DEV_SERVER_MISSING",
  "AGENT_CONVERSATIONS_EXPORT_PATH_UNSAFE",
  "AGENT_CONVERSATIONS_EXPORT_OUTPUT_EXISTS",
  "AGENT_GMAIL_CERTIFICATES_FAILED",
  "AGENT_GMAIL_REQUEST_FAILED",
  "AGENT_GMAIL_TOKEN_REFRESH_FAILED",
  "AGENT_INVOCATION_CLAIM_CONFLICT",
  "AGENT_INVOCATION_ID_AMBIGUOUS",
  "AGENT_CHANNELS_ADAPTER_MISSING",
  "AGENT_CHANNELS_CURSOR_INVALID",
  "AGENT_CHANNELS_EXPORT_TOO_LARGE",
  "AGENT_CHANNELS_FORBIDDEN",
  "AGENT_CHANNELS_HOST_UNAVAILABLE",
  "AGENT_CHANNELS_NOT_FOUND",
  "AGENT_CHANNELS_NO_CONVERSATIONS",
  "AGENT_CHANNELS_NO_STATUS",
  "AGENT_CHANNELS_PROVIDER_FAILED",
  "AGENT_CHANNELS_THREAD_UNKNOWN",
] as const

const params = { agent: "a", channel: "c", detail: "d", directory: "/tmp/out", method: "GET", need: "all", path: "p", archive: "history", read: "host", problem: "missing", root: "/app", rootDir: "/app", status: 500, thread: "t" } as const

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true })
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.agent.channels-console"))
})

it("gives each code that replaces an Agent error class a fix and its own docs page", () => {
  for (const code of codes) {
    const error = code === "AGENT_CHANNELS_FORBIDDEN"
      ? agentDiagnostics.AGENT_CHANNELS_FORBIDDEN({ problem: "conversations" })
      : code === "AGENT_CHANNELS_NOT_FOUND"
        ? agentDiagnostics.AGENT_CHANNELS_NOT_FOUND({ agent: "a", problem: "agent" })
        // SAFETY: the other codes read compatible fields from this shared object.
        : (agentDiagnostics[code] as (input: typeof params) => Error & { fix?: string, docs?: string })(params)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/agents/diagnostics/${code.toLowerCase()}`)
  }
})

it("prints the fix of a bad conversations export command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "vitehub-conversations-fix-"))
  directories.push(cwd)
  const stderr: string[] = []
  const code = await runConversationsExportCli(["support", "telegram", "t", "--media"], {
    cwd,
    env: {},
    rootDir: cwd,
    stderr: { write: chunk => stderr.push(String(chunk)) },
    stdout: { write: () => true },
  })
  expect(code).toBe(1)
  expect(stderr.join("")).toContain("--media needs --output")
  expect(stderr.join("")).toContain("Fix: Pass the Agent, the Channel, and the thread")
})

it("answers a Channel operation failure with its code, status, and fix", async () => {
  const context: OperationContext = { env: {}, surface: "console" } as OperationContext
  const list = agentChannelOperations[0]
  await expect(list.run({}, context)).rejects.toMatchObject({ code: "AGENT_CHANNELS_HOST_UNAVAILABLE", fix: expect.stringContaining("VITEHUB_AGENT_STATE_URL"), status: 503 })
  installChannelsConsoleHost({ agents: {}, handlers: {}, options: () => ({}) })
  const threads = agentChannelOperations[1]
  await expect(threads.run({ agent: "ghost", channel: "telegram" }, context)).rejects.toMatchObject({ code: "AGENT_CHANNELS_NOT_FOUND", fix: expect.stringContaining("vitehub channels list"), status: 404 })
})

it("keeps the status and message of an Agent HTTP error and gives it a fix", async () => {
  const error = agentHttpError(413, "Agent request body exceeds the configured byte limit.")
  expect(error).toMatchObject({ code: "AGENT_R0891", fix: expect.stringContaining("HTTP status"), status: 413 })
  const response = toHttpErrorResponse(error)!
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ error: "Agent request body exceeds the configured byte limit." })
})
