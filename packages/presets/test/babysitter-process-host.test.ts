import { createHmac, generateKeyPairSync } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createClient } from "@libsql/client"
import { defineAgent, resolveAgentTriggerInvocation } from "@vite-hub/agent"
import { getAgentProcessHostContribution, registerAgentProcessHostIntake } from "@vite-hub/agent/process"
import { withDeclaredAgentWorkspace } from "@vite-hub/agent/server/internal"
import { babysitter } from "../src/babysitter.ts"
import { usesProcessHostPreset } from "../../agent/src/discovery.ts"
import { createAgentProcessHosts } from "../../agent/src/runtime/process.ts"
import { createLibsqlAgentState } from "../../agent/src/state/sqlite.ts"
import { githubForge } from "./fixtures/github-forge.ts"

afterEach(() => {
  vi.unstubAllEnvs()
  registerAgentProcessHostIntake("babysitter", undefined)
})

describe("Babysitter process host", () => {
  it("declares its process host subpath for the Vite plugin", async () => {
    // An app that installs this package: the Agent plugin reads `vitehub.agent` from its package.json.
    const root = await mkdtemp(join(tmpdir(), "vitehub-presets-traits-"))
    try {
      await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true })
      await symlink(join(import.meta.dirname, ".."), join(root, "node_modules", "@vite-hub", "presets"), "dir")
      const file = join(root, "server", "agents", "babysitter.ts")
      expect(usesProcessHostPreset(`import { babysitter } from "@vite-hub/presets/babysitter"`, file)).toBe(true)
      expect(usesProcessHostPreset(`import { labeller } from "@vite-hub/presets/labeller"`, file)).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps the Babysitter host contribution through extends and options", () => {
    expect(getAgentProcessHostContribution(babysitter)).toBeDefined()
    const configured = defineAgent({ extends: babysitter, options: { concurrency: 2, filter: { repository: { allow: ["acme/app"] } }, mentionAllowlist: ["stefina"] } })
    expect(configured.options.mentionAllowlist).toEqual(["stefina"])
    expect(getAgentProcessHostContribution(configured)).toBe(getAgentProcessHostContribution(babysitter))
    expect(getAgentProcessHostContribution(defineAgent({ extends: configured, name: "child" }))).toBeDefined()
    expect(getAgentProcessHostContribution(defineAgent({ name: "plain", driver: { run: () => "" } }))).toBeUndefined()
    expect(() => defineAgent({ extends: babysitter, options: { concurrency: 0 } })).toThrow(/concurrency/)
  })

  it("owns no Workspace, so a folder Agent that extends it needs no workspace key", () => {
    const agent = defineAgent({ extends: babysitter, options: { filter: { repository: { allow: ["acme/app"] } }, merge: "direct" } })
    expect(withDeclaredAgentWorkspace(agent, "babysitter")).toBe(agent)
  })

  it("serves scheduler health while admission hangs and after reconcile stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-babysitter-health-"))
    const client = createClient({ url: `file:${join(root, "state.sqlite")}` })
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    vi.stubEnv("VITEHUB_GITHUB_APP_ID", "123")
    vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY", privateKey.export({ format: "pem", type: "pkcs1" }).toString())
    vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "webhook-secret")
    const { fetch } = await githubForge(({ path }) => path === "/app" ? { id: 123, slug: "repair" } : undefined)
    vi.stubGlobal("fetch", fetch)
    const check = vi.fn(() => new Promise<never>(() => {}))
    const agent = defineAgent({ name: "babysitter", extends: babysitter, options: {
      filter: { repository: { allow: ["acme/app"] } }, install: false, merge: false, admission: { check },
    } })
    const state = createLibsqlAgentState({ client })
    const hosts = createAgentProcessHosts({ names: ["babysitter"], registry: { babysitter: async () => ({ default: agent }) }, enabled: true, dataDir: root, state: () => state })
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    try {
      hosts.start()
      await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1), { timeout: 3000 })
      const poll = hosts.health()
      await vi.advanceTimersByTimeAsync(2000)
      const pending = Symbol("pending")
      const running = await Promise.race([poll, Promise.resolve(pending)])
      expect(running).toMatchObject({ status: "degraded", agents: { babysitter: {
        scheduler: { status: "ok", running: { step: "admission" } }, queue: expect.any(Object),
        diagnostics: expect.arrayContaining([expect.objectContaining({ label: "Health data", detail: "admission" })]),
      } } })
      expect(running).not.toHaveProperty("agents.babysitter.admission")
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      const afterStall = hosts.health()
      await vi.advanceTimersByTimeAsync(2000)
      expect(await Promise.race([afterStall, Promise.resolve(pending)])).toMatchObject({ status: "degraded", agents: { babysitter: {
        status: "degraded", scheduler: { status: "stalled", lastStall: { step: "admission", count: 1 } },
        diagnostics: expect.arrayContaining([expect.objectContaining({ label: "Scheduler" })]),
      } } })
    }
    finally {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      await hosts.close()
      vi.useRealTimers()
      vi.unstubAllGlobals()
      client.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("Babysitter webhook intake", () => {
  const payload = JSON.stringify({ action: "opened", repository: { full_name: "acme/app" } })
  const request = (secret: string) => new Request("https://example.test/_vitehub/agents/babysitter/webhooks/github", {
    method: "POST",
    body: payload,
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
  })
  const runtime = { memo: vi.fn(), runtime: "unknown" as const, waitUntil: vi.fn(), agentIdentity: { name: "babysitter" } }
  const input = { body: payload, payload: JSON.parse(payload), github: { deliveryId: "delivery-1", event: "pull_request" } }
  const agent = defineAgent({ extends: babysitter, name: "babysitter", options: { filter: { repository: { allow: ["acme/app"] } } } })

  it("passes a signed delivery to the running host without starting the Agent", async () => {
    vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "webhook-secret")
    const intake = vi.fn(async () => Response.json({ accepted: true }, { status: 202 }))
    registerAgentProcessHostIntake("babysitter", intake)
    const invocation = await resolveAgentTriggerInvocation(agent, { ...runtime, request: request("webhook-secret") }, "github.delivery", input)
    expect("response" in invocation && invocation.response.status).toBe(202)
    expect(intake).toHaveBeenCalledWith({ deliveryId: "delivery-1", event: "pull_request", payload: JSON.parse(payload) })
  })

  it("rejects a wrong signature and fails closed without a webhook secret", async () => {
    vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "webhook-secret")
    const intake = vi.fn()
    registerAgentProcessHostIntake("babysitter", intake)
    await expect(resolveAgentTriggerInvocation(agent, { ...runtime, request: request("wrong") }, "github.delivery", input)).rejects.toMatchObject({ statusCode: 401 })
    vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "")
    await expect(resolveAgentTriggerInvocation(agent, { ...runtime, request: request("") }, "github.delivery", input)).rejects.toThrow()
    expect(intake).not.toHaveBeenCalled()
  })

  it("reports 503 while the host has not started", async () => {
    vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "webhook-secret")
    const invocation = await resolveAgentTriggerInvocation(agent, { ...runtime, request: request("webhook-secret") }, "github.delivery", input)
    expect("response" in invocation && invocation.response.status).toBe(503)
  })
})
