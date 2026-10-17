import { readFileSync } from "node:fs"

import { afterEach, describe, expect, it, vi } from "vitest"

import { consoleProblem } from "../src/console/runtime/client/problem.ts"
import { ConsoleNetworkError, ConsoleRequestError, isRetryableConsoleRequestError, requestConsole } from "../src/console/runtime/client/request.ts"
import {
  consoleDiagnosticAction,
  consoleDiagnosticBody,
  consoleStatusDiagnosticCode,
  isConsoleDiagnosticCode,
  type ConsoleDiagnosticCode,
} from "../src/console/runtime/diagnostics.ts"

const codes = [
  "CONSOLE_ACCESS_DENIED",
  "CONSOLE_ACCESS_NOT_CONFIGURED",
  "CONSOLE_AUTH_NOT_CONFIGURED",
  "CONSOLE_CONFLICT",
  "CONSOLE_CONNECTIONS_MANAGEMENT_UNAVAILABLE",
  "CONSOLE_DEVELOPMENT_ONLY",
  "CONSOLE_ENV_MANAGEMENT_UNAVAILABLE",
  "CONSOLE_MANAGER_REQUIRED",
  "CONSOLE_NOT_FOUND",
  "CONSOLE_ORIGIN_REJECTED",
  "CONSOLE_REQUEST_FAILED",
  "CONSOLE_REQUEST_INVALID",
  "CONSOLE_SIGN_IN_REQUIRED",
  "CONSOLE_UNAVAILABLE",
] as const satisfies readonly ConsoleDiagnosticCode[]

const docsRoot = new URL("../../../docs/content/docs/", import.meta.url)

function headingAnchors(path: string): Set<string> {
  const file = new URL(`${path}.md`, docsRoot)
  const anchors = new Set<string>()
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const heading = /^#{2,4}\s+(.+)$/.exec(line)?.[1]
    if (heading) anchors.add(heading.toLowerCase().replace(/[`'"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
  }
  return anchors
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Console diagnostic catalog", () => {
  it.each(codes)("%s has a why, a fix, a docs anchor that exists, and an action", (code) => {
    expect(isConsoleDiagnosticCode(code)).toBe(true)
    const body = consoleDiagnosticBody(code)
    expect(body.code).toBe(code)
    expect(body.message.length).toBeGreaterThan(10)
    expect(body.fix?.length).toBeGreaterThan(10)
    const docs = new URL(body.docs ?? "")
    expect(docs.origin).toBe("https://vitehub.dev")
    const page = docs.pathname.replace(/^\/docs\//, "")
    if (docs.hash) expect(headingAnchors(page), body.docs).toContain(docs.hash.slice(1))
    expect(["docs", "reload", "retry", "sign-in"]).toContain(consoleDiagnosticAction(code))
  })

  it("uses a site message as the why and keeps the fix", () => {
    expect(consoleDiagnosticBody("CONSOLE_SIGN_IN_REQUIRED", "Cloudflare Access did not authenticate this request.")).toMatchObject({
      code: "CONSOLE_SIGN_IN_REQUIRED",
      fix: "Sign in again.",
      message: "Cloudflare Access did not authenticate this request.",
    })
  })

  it.each([
    [400, "CONSOLE_REQUEST_INVALID"],
    [401, "CONSOLE_SIGN_IN_REQUIRED"],
    [403, "CONSOLE_ACCESS_DENIED"],
    [404, "CONSOLE_NOT_FOUND"],
    [409, "CONSOLE_CONFLICT"],
    [413, "CONSOLE_REQUEST_INVALID"],
    [429, "CONSOLE_UNAVAILABLE"],
    [500, "CONSOLE_REQUEST_FAILED"],
    [503, "CONSOLE_UNAVAILABLE"],
  ])("maps status %i to %s", (status, code) => {
    expect(consoleStatusDiagnosticCode(status)).toBe(code)
  })

  it("rejects unknown codes", () => {
    expect(isConsoleDiagnosticCode("CONNECTION_FORBIDDEN")).toBe(false)
    expect(isConsoleDiagnosticCode(undefined)).toBe(false)
  })
})

describe("Console problems", () => {
  it("returns nothing without an error", () => {
    expect(consoleProblem(undefined)).toBeUndefined()
    expect(consoleProblem(null)).toBeUndefined()
  })

  it("shows the Connections 403 with its server fix and docs, and no retry", () => {
    const problem = consoleProblem(new ConsoleRequestError(403, {
      code: "CONNECTION_FORBIDDEN",
      docs: "https://vitehub.dev/docs/connections/server-api#management-routes",
      fix: "Sign in again. A custom actor function must return user:<id> for an allowed manager.",
      message: "The management route found no signed-in manager for this request.",
    }))
    expect(problem).toEqual({
      action: "docs",
      code: "CONNECTION_FORBIDDEN",
      docs: "https://vitehub.dev/docs/connections/server-api#management-routes",
      fix: "Sign in again. A custom actor function must return user:<id> for an allowed manager.",
      status: 403,
      why: "The management route found no signed-in manager for this request.",
    })
  })

  it("asks to sign in again for a 401 without a body", () => {
    expect(consoleProblem(new ConsoleRequestError(401))).toMatchObject({ action: "sign-in", code: "CONSOLE_SIGN_IN_REQUIRED", fix: "Sign in again.", status: 401 })
  })

  it.each([
    ["CONSOLE_MANAGER_REQUIRED", 403, "docs"],
    ["CONSOLE_ACCESS_NOT_CONFIGURED", 500, "docs"],
    ["CONNECTION_AUTH_REQUIRED", 500, "docs"],
    ["ENV_BRIDGE_UNTRUSTED", 503, "docs"],
    ["CONNECTION_PROVIDER", 502, "retry"],
    ["CONSOLE_UNAVAILABLE", 503, "retry"],
    ["CONSOLE_NOT_FOUND", 404, "reload"],
  ])("offers %s (%i) the %s action", (code, status, action) => {
    expect(consoleProblem(new ConsoleRequestError(status, { code, docs: "https://vitehub.dev/docs" }))?.action).toBe(action)
  })

  it("treats a network failure as a transient failure", () => {
    expect(consoleProblem(new ConsoleNetworkError(new TypeError("Failed to fetch")))).toMatchObject({ action: "retry", code: "CONSOLE_UNAVAILABLE" })
  })

  it("keeps the code and guidance of a thrown diagnostic", () => {
    const error = Object.assign(new Error("The Console returned an invalid definition catalog."), { code: "VITE_HUB_R0098", docs: "https://vitehub.dev/docs/reference/diagnostics" })
    expect(consoleProblem(error)).toMatchObject({ action: "docs", code: "VITE_HUB_R0098", docs: "https://vitehub.dev/docs/reference/diagnostics", why: "The Console returned an invalid definition catalog." })
  })

  it("does not retry an ordinary client or schema error", () => {
    expect(consoleProblem(new Error("Invalid Console response"))).toMatchObject({ action: "docs", code: "CONSOLE_REQUEST_FAILED" })
    expect(isRetryableConsoleRequestError(new Error("Invalid Console response"))).toBe(false)
  })

  it("retries automatically only when a retry can succeed", () => {
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(500, { code: "CONSOLE_ACCESS_NOT_CONFIGURED" }))).toBe(false)
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(403))).toBe(false)
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(503))).toBe(true)
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(502, { code: "CONNECTION_PROVIDER" }))).toBe(true)
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(501))).toBe(false)
    expect(isRetryableConsoleRequestError(new ConsoleRequestError(505))).toBe(false)
  })
})

describe("Console request diagnostics", () => {
  it("reads the diagnostic fields of an RPC failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      code: "CONSOLE_DEVELOPMENT_ONLY",
      docs: "https://vitehub.dev/docs/development/console#protect-the-console-route",
      fix: "Use Console Auth.",
      message: "console: true is development-only.",
      ok: false,
      status: 403,
    }, { status: 403 })))
    await expect(requestConsole("/api/_vitehub/console/sections")).rejects.toMatchObject({
      code: "CONSOLE_DEVELOPMENT_ONLY",
      docs: "https://vitehub.dev/docs/development/console#protect-the-console-route",
      fix: "Use Console Auth.",
      message: "console: true is development-only.",
      status: 403,
    })
  })

  it("uses a short plain-text rejection from host middleware as the why", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Cloudflare Access did not authenticate this request.", { headers: { "content-type": "text/plain" }, status: 401 })))
    const error = await requestConsole("/api/_vitehub/console/sections").catch((cause: unknown) => cause)
    expect(consoleProblem(error)).toMatchObject({
      action: "sign-in",
      code: "CONSOLE_SIGN_IN_REQUIRED",
      why: "Cloudflare Access did not authenticate this request.",
    })
  })
})
