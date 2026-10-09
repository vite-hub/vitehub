import { describe, expect, it, vi } from "vitest"

import { createCloudflareProvisionClient, createVercelProvisionClient, planProvisionSteps, ProvisionRequestError } from "../src/provision.ts"
import type { ProvisionAction, ProvisionContext, ProvisionStep } from "../src/provision.ts"

describe("provision planning", () => {
  const context = (): Omit<ProvisionContext, "markPlanUnchecked"> => ({
    env: { PROJECT_NAME: "example" },
    fetch: vi.fn<typeof globalThis.fetch>(),
    logger: { log: vi.fn(), warn: vi.fn() },
  })

  it("plans only the selected provider in order without applying actions", async () => {
    const planningContext = context()
    const calls: string[] = []
    const action: ProvisionAction = { kind: "database", name: "primary", exists: false, apply: vi.fn() }
    const steps: ProvisionStep[] = [
      {
        id: "database",
        provider: "cloudflare",
        async plan(received) {
          expect(received.env).toBe(planningContext.env)
          expect(received.fetch).toBe(planningContext.fetch)
          await Promise.resolve()
          calls.push("database")
          return [action]
        },
      },
      { id: "vercel-only", provider: "vercel", plan: vi.fn() },
      {
        id: "bindings",
        provider: "cloudflare",
        async plan() {
          expect(calls).toEqual(["database"])
          calls.push("bindings")
          return [action]
        },
      },
    ]

    await expect(planProvisionSteps("cloudflare", steps, planningContext)).resolves.toEqual({
      actions: [{ action, step: "database" }, { action, step: "bindings" }],
      checked: true,
      warnings: [],
    })
    expect(calls).toEqual(["database", "bindings"])
    expect(steps[1]!.plan).not.toHaveBeenCalled()
    expect(action.apply).not.toHaveBeenCalled()
  })

  it("collects warnings and explicit unchecked state while forwarding messages", async () => {
    const planningContext = context()
    const steps: ProvisionStep[] = [{
      id: "database",
      provider: "vercel",
      async plan(received) {
        received.logger.log("Checking primary")
        received.logger.warn("Check was unavailable")
        received.markPlanUnchecked?.()
        return []
      },
    }]

    await expect(planProvisionSteps("vercel", steps, planningContext)).resolves.toEqual({
      actions: [], checked: false, warnings: ["Check was unavailable"],
    })
    expect(planningContext.logger.log).toHaveBeenCalledWith("Checking primary")
    expect(planningContext.logger.warn).toHaveBeenCalledWith("Check was unavailable")
  })

  it("keeps a warning-only plan checked and does not retain earlier plan state", async () => {
    const planningContext = context()
    const steps: ProvisionStep[] = [{
      id: "database",
      provider: "vercel",
      async plan(received) {
        received.logger.warn("Using the existing database")
        return []
      },
    }]

    await expect(planProvisionSteps("vercel", steps, planningContext)).resolves.toEqual({
      actions: [], checked: true, warnings: ["Using the existing database"],
    })
    await expect(planProvisionSteps("vercel", [], planningContext)).resolves.toEqual({
      actions: [], checked: true, warnings: [],
    })
  })
})

describe("provision request errors", () => {
  it("ignores an inherited response parser", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: "raw" }))
    const parse = vi.fn(() => ({ id: "parsed" }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)
    const options = Object.create({ parse }) as { parse: typeof parse }

    await expect(request("/v1/storage/connections", options)).resolves.toEqual({ id: "raw" })
    expect(parse).not.toHaveBeenCalled()
  })

  it("uses an own response parser", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: "raw" }))
    const parse = vi.fn(() => ({ id: "parsed" }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)

    await expect(request("/v1/storage/connections", { parse })).resolves.toEqual({ id: "parsed" })
    expect(parse).toHaveBeenCalledWith({ id: "raw" })
  })

  it("reports Vercel error codes without leaking provider response details", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      error: { code: "invalid_connection_type", message: "provider-secret" },
    }, { status: 400 }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)

    const error = await request("/v1/storage/connections", { method: "POST" }).catch(error => error)

    expect(error).toBeInstanceOf(ProvisionRequestError)
    expect(error).toMatchObject({ codes: ["invalid_connection_type"], status: 400 })
    expect(error.message).toBe("Provision request failed: POST /v1/storage/connections (400). Provider code: invalid_connection_type.")
    expect(error.message).not.toContain("provider-secret")
  })

  it("preserves Cloudflare numeric error codes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      errors: [{ code: 10004, message: "provider-secret" }],
    }, { status: 409 }))
    const request = createCloudflareProvisionClient({ accountId: "account", token: "token" }, fetch)

    const error = await request("/storage/buckets").catch(error => error)

    expect(error).toMatchObject({ codes: [10004], status: 409 })
    expect(error.message).toBe("Provision request failed: GET /storage/buckets (409). Provider code: 10004.")
    expect(error.message).not.toContain("provider-secret")
  })

  it("ignores unsafe provider error codes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({
      error: { code: "provider-secret\nsecond-log-line" },
    }, { status: 400 }))
    const request = createVercelProvisionClient({ token: "token" }, fetch)

    const error = await request("/v1/storage/connections").catch(error => error)

    expect(error).toMatchObject({ codes: [] })
    expect(error.message).toBe("Provision request failed: GET /v1/storage/connections (400).")
  })
})
