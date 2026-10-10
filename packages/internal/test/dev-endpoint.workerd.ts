import { assertViteHubDevRequestGrant, validateViteHubNitroDevRequest } from "../src/dev-endpoint.ts"
import { isViteHubBearerSecretEqual, isViteHubSecretEqual } from "../src/secret.ts"

import type { ViteHubDevRequestGrant } from "../src/dev-endpoint.ts"

const guard = { header: "x-test-dev", headerValue: "1", label: "Test Dev" }

function devRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/_vitehub/test/dev", {
    body: "{}",
    headers: { "content-type": "application/json", [guard.header]: guard.headerValue, ...headers },
    method: "POST",
  })
}

describe("Nitro dev request check in workerd", () => {
  it("compares secrets without Node APIs", () => {
    expect(isViteHubSecretEqual("token", "token")).toBe(true)
    expect(isViteHubSecretEqual("tokem", "token")).toBe(false)
    expect(isViteHubSecretEqual("toke", "token")).toBe(false)
    expect(isViteHubSecretEqual(null, "token")).toBe(false)
    expect(isViteHubBearerSecretEqual("Bearer token", "token")).toBe(true)
    expect(isViteHubBearerSecretEqual("Bearer tokem", "token")).toBe(false)
  })

  it("grants a guarded request and rejects a forged grant", async () => {
    const authorize = async (request: Request) => isViteHubSecretEqual(request.headers.get("x-test-token"), "secret")
      ? undefined
      : new Response("Forbidden token.", { status: 403 })
    const request = devRequest({ "x-test-token": "secret" })
    const { grant } = await validateViteHubNitroDevRequest(request, { ...guard, authorize })
    expect(() => assertViteHubDevRequestGrant(grant!, request)).not.toThrow()
    expect((await validateViteHubNitroDevRequest(devRequest({ "x-test-token": "secreT" }), { ...guard, authorize })).rejection?.status).toBe(403)
    // SAFETY: the test forges a grant at runtime, as JavaScript callers can.
    expect(() => assertViteHubDevRequestGrant({ label: "Test Dev" } as unknown as ViteHubDevRequestGrant, request)).toThrow()
  })
})
