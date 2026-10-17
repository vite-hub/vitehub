import { createHmac } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseAst } from "vite-plus"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineAgent, resolveAgentTriggerInvocation } from "@vite-hub/agent"
import { getAgentProcessHostContribution, registerAgentProcessHostIntake } from "@vite-hub/agent/process-host"
import { babysitter } from "../src/babysitter.ts"
import { usesProcessHostPreset } from "../../agent/src/discovery.ts"
import { usesProviderAgentDriver } from "../../agent/src/internal/provider-driver-usage.ts"

afterEach(() => {
  vi.unstubAllEnvs()
  registerAgentProcessHostIntake("babysitter", undefined)
})

describe("Babysitter process host", () => {
  it("declares its process host and provider Driver subpaths for the Vite plugin", async () => {
    // An app that installs this package: the Agent plugin reads `vitehub.agent` from its package.json.
    const root = await mkdtemp(join(tmpdir(), "vitehub-presets-traits-"))
    try {
      await mkdir(join(root, "node_modules", "@vite-hub"), { recursive: true })
      await symlink(join(import.meta.dirname, ".."), join(root, "node_modules", "@vite-hub", "presets"), "dir")
      const file = join(root, "server", "agents", "babysitter.ts")
      const parse = (source: string) => parseAst(source, { lang: "ts" })
      expect(usesProcessHostPreset(`import { babysitter } from "@vite-hub/presets/babysitter"`, file)).toBe(true)
      expect(usesProcessHostPreset(`import { labeller } from "@vite-hub/presets/labeller"`, file)).toBe(false)
      expect(usesProviderAgentDriver(`import workspace from "@vite-hub/presets/workspace"`, parse, file)).toBe(true)
      expect(usesProviderAgentDriver(`import { labeller } from "@vite-hub/presets/labeller"`, parse, file)).toBe(false)
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
})

describe("Babysitter webhook intake", () => {
  const payload = JSON.stringify({ action: "opened", repository: { full_name: "acme/app" } })
  const request = (secret: string) => new Request("https://example.test/api/_vitehub/agents/babysitter/webhooks/github", {
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
