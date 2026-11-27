import { expect, it, vi } from "vitest"

import { createGitHubHost } from "../src/github/host.ts"
import { hasRuntimeType, isRuntimeRecord } from "../src/internal/runtime-type.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

it("serializes separate activity channels created from the same GitHub host", async () => {
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let tokens = 0, writes = 0, activeWrites = 0, maxActiveWrites = 0
  let storedBody = "<!-- vitehub-agent-activity:e30 -->"
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(hasRuntimeType(input, "string") || input instanceof URL ? input : input.url)
    if (url.pathname === "/user") return Response.json({ id: 789, login: "shared-host-bot" })
    if (!init?.method || init.method === "GET") return Response.json([{ id: 7, body: storedBody, user: { login: "shared-host-bot" } }])
    activeWrites++; maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
    try {
      if (++writes === 1) { entered(); await blocked }
      const payload: unknown = JSON.parse(String(init.body))
      if (!isRuntimeRecord(payload) || !hasRuntimeType(payload.body, "string")) throw new Error("Invalid comment body")
      storedBody = payload.body
      return Response.json({ id: 7 })
    } finally { activeWrites-- }
  })
  const host = createGitHubHost({ credentials: () => ({ token: `shared-host-token-${++tokens}` }), identity: { login: "shared-host-bot" } })
  const channels = [host.channel({ activity: true }), host.channel({ activity: true })]
  const context = (channel: typeof channels[number], status: "waiting" | "running") => ({
    activity: { agentName: "shared-reviewer", links: [], runId: "shared-run", status, tasks: [], summary: "Shared status" },
    channel, memo: vi.fn(), run: { runId: "shared-run" }, runtime: "unknown", target: { repository: "acme/shared-host", issue: 42 }, waitUntil: vi.fn(),
  })
  // SAFETY: The fixture supplies the activity callback fields consumed by GitHub.
  const first = channels[0]!.activity!.update(context(channels[0]!, "waiting") as never)
  await started
  // SAFETY: The fixture supplies the activity callback fields consumed by GitHub.
  const second = channels[1]!.activity!.update(context(channels[1]!, "running") as never)
  try { await new Promise(resolve => setTimeout(resolve, 50)) }
  finally { release(); await Promise.all([first, second]); vi.unstubAllGlobals() }
  expect(maxActiveWrites).toBe(1)
  expect(storedBody).toContain("| Running |")
})
