import { describe, expect, it } from "vitest"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { deriveSecret, inspectServerEnv, loadServerEnv, resolveServerEnv, runWithCloudflareEnv } from "../src/server.ts"
import { cloudflareRequest } from "./cloudflare-request.ts"
import type { ViteHubContext } from "@vite-hub/runtime"

const bindings = { STANDARD_CONTEXT_TOKEN: "request-token", VITEHUB_SECRET: "request-root-secret-at-least-32-characters" }

function requestEvent(): ViteHubContext {
  const context = { cloudflare: { env: bindings } }
  const event = { context, req: new Request("https://example.test/"), res: { headers: new Headers() } }
  // H3's event type is augmented, but a standalone app has not installed the property yet.
  return event as never
}

function registry() {
  return createRuntimeRegistry({ token: env({ source: env.source("STANDARD_CONTEXT_TOKEN") }) })
}

describe("Server Env Standard Context", () => {
  it("installs Standard Context for an H3 event before reading bindings", async () => {
    const event = requestEvent()
    expect(event).not.toHaveProperty("~standard")
    expect(resolveServerEnv(registry(), event)).toEqual({ token: "request-token" })
    expect(event["~standard"].runtime?.cloudflare?.env).toBe(bindings)
    await expect(loadServerEnv(registry(), requestEvent())).resolves.toEqual({ token: "request-token" })
    await expect(inspectServerEnv(registry(), requestEvent())).resolves.toMatchObject({ entries: [{ status: "available" }] })
    await expect(deriveSecret("test:context", { event: requestEvent() })).resolves.toBe(
      await deriveSecret("test:context", { event: cloudflareRequest(bindings) }),
    )
  })

  it("prefers host Standard Context over the event and active bindings", () => {
    const event = Object.assign(cloudflareRequest(bindings), { context: { cloudflare: { env: { STANDARD_CONTEXT_TOKEN: "other-token" } } } })
    runWithCloudflareEnv({ STANDARD_CONTEXT_TOKEN: "active-token" }, () => {
      expect(resolveServerEnv(registry(), event)).toEqual({ token: "request-token" })
    })
  })

  it("uses active bindings for Auth's Request and for calls without an event", () => {
    runWithCloudflareEnv(bindings, () => {
      const request = new Request("https://example.test/")
      expect(resolveServerEnv(registry(), request as never)).toEqual({ token: "request-token" })
      // A Request without host data gets a `fetch` Standard Context without bindings, so Env reads the active bindings.
      expect((request as Request & ViteHubContext)["~standard"]).toMatchObject({ runtime: {}, vendor: "fetch" })
      expect(resolveServerEnv(registry())).toEqual({ token: "request-token" })
    })
  })
})
