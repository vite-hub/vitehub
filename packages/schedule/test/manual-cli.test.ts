import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createViteHubDevToken, removeViteHubDevToken, viteHubDevTokenHeader } from "@vite-hub/internal/dev-token"
import { runScheduleCli, runScheduleRunCli } from "../src/cli.ts"
import { scheduleDevHeader, scheduleDevHeaderValue, scheduleDevRoute, scheduleDevTokenNamespace, scheduleDevTokenServerHeader } from "../src/dev.ts"

const tokenReads = vi.hoisted(() => vi.fn())
vi.mock("@vite-hub/internal/dev-token", async importOriginal => {
  const actual = await importOriginal<typeof import("@vite-hub/internal/dev-token")>()
  return { ...actual, readViteHubDevToken: (...args: Parameters<typeof actual.readViteHubDevToken>) => { tokenReads(...args); return actual.readViteHubDevToken(...args) } }
})

it("sends a local static run to the guarded Nitro dev endpoint with the private token", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-manual-cli-"))
  const credential = await createViteHubDevToken(root, scheduleDevTokenNamespace)
  try {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => init?.method === "POST"
      ? Response.json({ run: { completedAt: "2026-05-22T07:00:00.005Z", id: "srun_manual_sync_1", scheduleId: "sync", startedAt: "2026-05-22T07:00:00.000Z", status: "succeeded" } })
      : Response.json({ root, runtime: "nitro", scheduleDevTokenServerId: credential.serverId }))
    let stdout = ""
    let stderr = ""
    expect(await runScheduleRunCli(["sync", "--server", "http://localhost:4000"], { cwd: root, rootDir: root, env: { VITEHUB_CONSOLE_AUTHORIZATION: "Bearer credential" }, stdout: { write: chunk => { stdout += String(chunk) } }, stderr: { write: chunk => { stderr += String(chunk) } } }, { fetch })).toBe(0)
    expect(stdout).toBe("succeeded sync in 5 ms\nRun srun_manual_sync_1\n")
    expect(stderr).toBe("")
    expect(fetch).toHaveBeenCalledTimes(2)
    const [discovery, run] = fetch.mock.calls
    expect(discovery?.[0]).toBe(`http://localhost:4000${scheduleDevRoute}`)
    expect(new Headers(discovery?.[1]?.headers).get(scheduleDevHeader)).toBe(scheduleDevHeaderValue)
    expect(run?.[0]).toBe(`http://localhost:4000${scheduleDevRoute}`)
    expect(run?.[1]).toMatchObject({ body: JSON.stringify({ id: "sync", operation: "run-static" }), method: "POST", redirect: "manual" })
    const headers = new Headers(run?.[1]?.headers)
    expect(headers.get(scheduleDevHeader)).toBe(scheduleDevHeaderValue)
    expect(headers.get(viteHubDevTokenHeader)).toBe(credential.token)
    expect(headers.get(scheduleDevTokenServerHeader)).toBe(credential.serverId)
    expect(headers.get("authorization")).toBeNull()
  }
  finally {
    await removeViteHubDevToken(root, { namespace: scheduleDevTokenNamespace, serverId: credential.serverId })
    await rm(root, { recursive: true, force: true })
  }
})

it("reports dev endpoint failures and redacts failed runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-manual-cli-"))
  const credential = await createViteHubDevToken(root, scheduleDevTokenNamespace)
  const responses = [
    Response.json({ error: { code: "SCHEDULE_MANUAL_RUN_DISABLED", message: "Schedule Definition does not allow manual runs." } }, { status: 403 }),
    Response.json({ run: { error: { message: "Bearer private-secret" }, id: "srun_manual_fail_1", scheduleId: "fail", status: "failed" } }),
  ]
  try {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => init?.method === "POST"
      ? responses.shift()!
      : Response.json({ root, runtime: "nitro", scheduleDevTokenServerId: credential.serverId }))
    let stdout = ""
    const context = { cwd: root, rootDir: root, env: {}, stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk) } }, stderr: { write: () => {} } }
    expect(await runScheduleRunCli(["locked", "--json"], context, { fetch })).toBe(1)
    expect(JSON.parse(stdout)).toEqual({ error: { message: "Schedule run failed with HTTP 403: Schedule Definition does not allow manual runs." } })
    stdout = ""
    expect(await runScheduleCli(["run", "fail", "--json"], context, { fetch })).toBe(1)
    expect(JSON.parse(stdout)).toMatchObject({ status: "failed", error: { message: "Bearer [redacted]" } })
    expect(stdout).not.toContain("private-secret")
  }
  finally {
    await removeViteHubDevToken(root, { namespace: scheduleDevTokenNamespace, serverId: credential.serverId })
    await rm(root, { recursive: true, force: true })
  }
})

it("reports a host without a Nitro dev runtime before reading credentials", async () => {
  tokenReads.mockClear()
  const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => Response.json({ message: "No Nitro here.", root: "/expected-app", runtime: "unavailable", scheduleDevTokenServerId: "instance" }))
  let stderr = ""
  expect(await runScheduleRunCli(["sync"], { cwd: "/expected-app", rootDir: "/expected-app", env: {}, stdout: { write: () => {} }, stderr: { write: chunk => { stderr += String(chunk) } } }, { fetch })).toBe(1)
  expect(stderr).toBe("No Nitro here.\n")
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(tokenReads).not.toHaveBeenCalled()
})

it("preserves authenticated Console targeting for static run and redacts its result", async () => {
  let stdout = ""
  let stderr = ""
  const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => Response.json({ run: { id: "srun_manual_sync_1", status: "failed", error: { name: "access_token=secret-name", message: "Bearer private-secret", stack: "secret-stack" } } }))
  expect(await runScheduleRunCli(["sync", "--url", "https://app.example.com/base/", "--json"], { env: { VITEHUB_CONSOLE_AUTHORIZATION: "Bearer credential" }, stdout: { write: chunk => { stdout += String(chunk) } }, stderr: { write: chunk => { stderr += String(chunk) } } }, { fetch })).toBe(1)
  expect(fetch).toHaveBeenCalledWith("https://app.example.com/base/_vitehub/schedules/run", expect.objectContaining({ body: '{"name":"sync"}', headers: expect.any(Headers), method: "POST", redirect: "manual" }))
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer credential")
  expect(JSON.parse(stdout)).toMatchObject({ status: "failed", error: { name: "access_token=[redacted]", message: "Bearer [redacted]" } })
  expect(stdout).not.toMatch(/secret-name|private-secret|secret-stack/)
  expect(stderr).toBe("")
})

it.each(["/different-app", undefined])("rejects discovery root %s before reading credentials or sending a static run", async root => {
  tokenReads.mockClear()
  const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => Response.json({ root, runtime: "nitro", scheduleDevTokenServerId: "other-instance" }))
  let stdout = ""
  let stderr = ""
  expect(await runScheduleRunCli(["sync", "--json"], { cwd: "/expected-app", rootDir: "/expected-app", env: {}, stdout: { write: chunk => { stdout += String(chunk) } }, stderr: { write: chunk => { stderr += String(chunk) } } }, { fetch })).toBe(1)
  expect(tokenReads).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(stdout)).toHaveProperty("error.message")
  expect(stderr).toBe("")
})
