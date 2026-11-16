import { HTTPError } from "nitro/h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { checkServiceToken, requireServiceToken } from "../src/service-token.ts"
import { runWithCloudflareEnv } from "../src/server.ts"
import { cloudflareRequest } from "./cloudflare-request.ts"
import type { ViteHubContext } from "@vite-hub/runtime"

function request(authorization?: string): Request {
  return new Request("https://example.test/api/ingest", { headers: authorization ? { authorization } : {} })
}

function thrown(callback: () => void): HTTPError {
  try {
    callback()
  }
  catch (error) {
    if (HTTPError.isError(error)) return error
    throw error
  }
  throw new Error("Expected an HTTPError.")
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("checkServiceToken()", () => {
  it("accepts the bearer token of the variable", () => {
    vi.stubEnv("INGEST_TOKEN", "runner-token-2026")
    expect(checkServiceToken(request("Bearer runner-token-2026"), "INGEST_TOKEN")).toEqual([undefined, undefined])
    expect(checkServiceToken(request("bearer runner-token-2026"), "INGEST_TOKEN")[0]).toBeUndefined()
  })

  it("accepts each token of a comma-separated list, for rotation", () => {
    vi.stubEnv("INGEST_TOKEN", "old-token, new-token")
    expect(checkServiceToken(request("Bearer old-token"), "INGEST_TOKEN")[0]).toBeUndefined()
    expect(checkServiceToken(request("Bearer new-token"), "INGEST_TOKEN")[0]).toBeUndefined()
    expect(checkServiceToken(request("Bearer old-token, new-token"), "INGEST_TOKEN")[0]?.code).toBe("ENV_SERVICE_TOKEN_INVALID")
  })

  it("refuses a missing, wrong, or non-bearer credential", () => {
    vi.stubEnv("INGEST_TOKEN", "runner-token-2026")
    for (const authorization of [undefined, "Bearer runner-token", "Bearer runner-token-2026x", "Basic runner-token-2026", "runner-token-2026"]) {
      const [error] = checkServiceToken(request(authorization), "INGEST_TOKEN")
      expect(error?.code, authorization).toBe("ENV_SERVICE_TOKEN_INVALID")
    }
  })

  it("refuses every request when the variable has no token", () => {
    for (const value of [undefined, "", " , "]) {
      if (value === undefined) vi.stubEnv("INGEST_TOKEN", undefined)
      else vi.stubEnv("INGEST_TOKEN", value)
      const [error] = checkServiceToken(request("Bearer "), "INGEST_TOKEN")
      expect(error).toMatchObject({ code: "ENV_SERVICE_TOKEN_UNSET", why: "`INGEST_TOKEN` has no token on this server, so every request is refused." })
      expect(error?.docs).toBe("https://vitehub.dev/docs/env/diagnostics/env_service_token_unset")
    }
  })

  it("reads Cloudflare bindings from the request event and from the active request", () => {
    const bindings = { INGEST_TOKEN: "worker-token" }
    const event = cloudflareRequest(bindings)
    event["~standard"].req.headers.set("authorization", "Bearer worker-token")
    expect(checkServiceToken(event, "INGEST_TOKEN")[0]).toBeUndefined()
    runWithCloudflareEnv(bindings, () => {
      expect(checkServiceToken(request("Bearer worker-token"), "INGEST_TOKEN")[0]).toBeUndefined()
    })
  })

  it("reads an H3 event", () => {
    vi.stubEnv("INGEST_TOKEN", "runner-token-2026")
    const event = { context: {}, req: request("Bearer runner-token-2026"), res: { headers: new Headers() } }
    // An H3 event before Nitro installs Standard Context.
    expect(checkServiceToken(event as unknown as ViteHubContext, "INGEST_TOKEN")[0]).toBeUndefined()
  })
})

describe("requireServiceToken()", () => {
  it("returns for a valid token", () => {
    vi.stubEnv("INGEST_TOKEN", "runner-token-2026")
    expect(requireServiceToken(request("Bearer runner-token-2026"), "INGEST_TOKEN")).toBeUndefined()
  })

  it("throws a 401 HTTPError with the code for a wrong token", () => {
    vi.stubEnv("INGEST_TOKEN", "runner-token-2026")
    const error = thrown(() => requireServiceToken(request("Bearer nope"), "INGEST_TOKEN"))
    expect(error.status).toBe(401)
    expect(error.data).toEqual({ code: "ENV_SERVICE_TOKEN_INVALID" })
    expect(error.headers?.get("www-authenticate")).toBe("Bearer")
    expect(error.message).toBe("The request has no `Authorization: Bearer` token that matches a token in `INGEST_TOKEN`.")
  })

  it("throws a 503 HTTPError with the code when the variable has no token", () => {
    vi.stubEnv("INGEST_TOKEN", "")
    const error = thrown(() => requireServiceToken(request("Bearer "), "INGEST_TOKEN"))
    expect(error.status).toBe(503)
    expect(error.data).toEqual({ code: "ENV_SERVICE_TOKEN_UNSET" })
  })
})
