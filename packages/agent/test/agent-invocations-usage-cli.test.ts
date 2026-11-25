import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConsoleKeyPair } from "@vite-hub/internal/console-signature"
import { afterEach, describe, expect, it, vi } from "vitest"

import { runAgentInvocationsCli } from "../src/internal/agent-invocations-cli.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { agentUsagePeriod, agentUsageRow, summarizeAgentUsage } from "../src/usage.ts"

import type { AgentInvocationRecordStatus } from "../src/invocations.ts"
import type { AgentUsageQuery } from "../src/usage.ts"
import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

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

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

const hour = 3_600_000
const priced = (usd: string, tokens: number) => ({ cost: { estimated: false, usd }, model: "provider:model", usage: { inputTokens: tokens, outputTokens: 1, totalTokens: tokens + 1 } })

async function fixtureJournal() {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-usage-"))
  directories.push(directory)
  const path = join(directory, "journal.sqlite")
  const store = createLibsqlAgentInvocationStore({ maxAge: false, maxRecords: false, url: `file:${path}` })
  const records: Array<{ id: string, agentName: string, status: AgentInvocationRecordStatus, at: string, usage?: unknown }> = [
    { agentName: "bot", at: new Date(Date.now() - 2 * hour).toISOString(), id: "fix-sync", status: "completed", usage: priced("0.25", 100) },
    { agentName: "bot", at: new Date(Date.now() - 3 * hour).toISOString(), id: "fix-cursor", status: "failed", usage: priced("0.5", 200) },
    { agentName: "triage", at: new Date(Date.now() - 4 * hour).toISOString(), id: "triage-1", status: "completed", usage: priced("1", 10) },
    { agentName: "bot", at: new Date(Date.now() - 5 * hour).toISOString(), id: "no-usage", status: "cancelled" },
    { agentName: "bot", at: new Date(Date.now() - 60 * hour).toISOString(), id: "older", status: "completed", usage: priced("2", 10) },
    { agentName: "bot", at: new Date(Date.now() - hour).toISOString(), id: "running", status: "running" },
  ]
  for (const { agentName, at, id, status, usage } of records) {
    await store.create({
      agentName, createdAt: at, id, status, traceId: id, updatedAt: at,
      ...(status === "running" ? {} : { completedAt: at }),
      observations: usage === undefined ? [] : [{ attributes: { "usage.record": usage }, name: "agent.invocation.finish", sequence: 1, timestamp: at, type: "lifecycle" }],
    })
  }
  return { path, store }
}

async function run(args: string[]) {
  const stdout = stream()
  const stderr = stream()
  const fetch = vi.fn()
  // SAFETY: The mock only proves that a journal file read sends no request.
  const exitCode = await runAgentInvocationsCli(args, { env: {}, stderr, stdout }, { fetch: fetch as unknown as typeof globalThis.fetch })
  expect(fetch).not.toHaveBeenCalled()
  return { exitCode, stderr: stderr.output(), stdout: stdout.output() }
}

describe("vitehub agent invocations usage", () => {
  it("adds up a local journal file with one SQL query, as the Console does", async () => {
    const { path, store } = await fixtureJournal()
    for (const [args, query] of [
      [[], { window: "30d" }],
      [["--window", "24h"], { window: "24h" }],
      [["--window=7d", "--agent", "bot", "--status", "completed"], { agentName: "bot", status: "completed", window: "7d" }],
      [["--search=cursor"], { search: "cursor" }],
    ] satisfies Array<[string[], AgentUsageQuery]>) {
      const result = await run(["usage", "--database", path, "--json", ...args])
      expect(result.exitCode, result.stderr).toBe(0)
      const { generatedAt: _printed, from, to, ...printed } = JSON.parse(result.stdout)
      const period = agentUsagePeriod({ ...query, now: to })
      if ("problem" in period) throw new Error(period.problem)
      const rows = await Promise.all((await store.list({ limit: 100 })).invocations.map(async summary => agentUsageRow((await store.get(summary.id))!)))
      const { generatedAt: _expected, ...expected } = summarizeAgentUsage(rows, query, period)
      expect({ ...printed, from, to }).toEqual(expected)
    }
    const all = JSON.parse((await run(["usage", "--database", path, "--json"])).stdout)
    expect(all.totals).toMatchObject({ costUsd: "3.75", invocations: 5 })
    expect(all.agents.map((agent: { agent: string }) => agent.agent)).toEqual(["bot", "triage"])
  })

  it("prints the totals as text", async () => {
    const { path } = await fixtureJournal()
    const completed = await run(["usage", "--database", path, "--window", "24h", "--status", "completed"])
    expect(completed.exitCode, completed.stderr).toBe(0)
    expect(completed.stdout).toMatch(/^Agent usage from .+ to .+: 2 Invocations, 112 tokens, \$1\.25\n {2}bot: 1 Invocation, 101 tokens, \$0\.25\n {2}triage: 1 Invocation, 11 tokens, \$1\n$/)
    const all = await run(["usage", "--database", path, "--window", "24h"])
    expect(all.exitCode, all.stderr).toBe(0)
    expect(all.stdout).toMatch(/: 4 Invocations, tokens not recorded\n[^]*Some Invocations did not record all of their usage\.\n$/)
  })

  it("refuses a window, a status, or a filter that usage does not support", async () => {
    const { path } = await fixtureJournal()
    expect((await run(["usage", "--database", path, "--window", "2d"])).stderr).toContain("--window must be one of 24h, 7d, 14d, 30d, or 90d.")
    expect((await run(["usage", "--database", path, "--status", "running"])).stderr).toContain("--status must be one of completed, failed, cancelled for usage.")
    expect((await run(["list", "--database", path, "--window", "7d"])).stderr).toContain("--window and --search are only supported for usage.")
  })

  it("asks the app for invocations.usage with --url", async () => {
    const answer = { agents: [{ agent: "bot", costAvailable: true, costEstimated: false, costUsd: "0.25", invocations: 1, totalTokens: 101, totalTokensAvailable: true }], from: "2026-11-22T00:00:00.000Z", partial: false, to: "2026-11-23T00:00:00.000Z", totals: { costAvailable: true, costEstimated: false, costUsd: "0.25", invocations: 1, totalTokens: 101, totalTokensAvailable: true } }
    const calls: Array<{ input: unknown, operation: string }> = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(operationRpcRequest(init?.body))
      return operationRpcResponse(init?.body, { ok: true, value: answer })
    })
    const stdout = stream()
    const stderr = stream()
    const env = { VITEHUB_CONSOLE_PRIVATE_KEY_CI: (await createConsoleKeyPair()).privateKey }
    // SAFETY: The mock implements the fetch call shape that the CLI uses.
    const exitCode = await runAgentInvocationsCli(["usage", "--url", "https://agent.example.com", "--window", "24h", "--agent", "bot", "--search", "fix"], { env, stderr, stdout }, { fetch: fetch as unknown as typeof globalThis.fetch })
    expect(stderr.output()).toBe("")
    expect(exitCode).toBe(0)
    expect(calls).toEqual([{ input: { agent: "bot", search: "fix", window: "24h" }, operation: "invocations.usage" }])
    expect(stdout.output()).toBe("Agent usage from 2026-11-22T00:00:00.000Z to 2026-11-23T00:00:00.000Z: 1 Invocation, 101 tokens, $0.25\n  bot: 1 Invocation, 101 tokens, $0.25\n")
  })
})
