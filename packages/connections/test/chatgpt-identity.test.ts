import { afterEach, describe, expect, it } from "vitest"
import * as v from "valibot"

import { chatgptIssuer, chatgptResource, verifyChatGPTIdentity } from "../src/internal/chatgpt-identity.ts"
import { codeChallenge, randomToken } from "../src/internal/oauth-crypto.ts"
import { createChatGPTFake } from "./chatgpt-fake.ts"

const fakes: Awaited<ReturnType<typeof createChatGPTFake>>[] = []
afterEach(async () => {
  await Promise.all(fakes.splice(0).map(fake => fake.close()))
})

async function identityAttempt(claims: Record<string, unknown> = {}, wrongKey = false) {
  const now = Date.now()
  const fake = await createChatGPTFake(() => now)
  fakes.push(fake)
  fake.state.idClaims = claims
  fake.state.signWithWrongKey = wrongKey
  const nonce = randomToken()
  const verifier = randomToken()
  const redirectUri = "http://127.0.0.1:1455/callback"
  const authorize = new URL(`${chatgptIssuer}/api/accounts/authorize`)
  authorize.search = new URLSearchParams({
    client_id: "dynamic_agent_client", nonce, state: randomToken(), redirect_uri: redirectUri,
    code_challenge: await codeChallenge(verifier), scope: fake.state.scopes,
  }).toString()
  const callback = await fake.callback(authorize.href)
  const clientId = callback.searchParams.get("client_id")!
  const response = await fake.fetch(`${chatgptIssuer}/api/accounts/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, grant_type: "authorization_code", code: callback.searchParams.get("code")!, code_verifier: verifier, redirect_uri: redirectUri, resource: chatgptResource }),
  })
  const { id_token: idToken } = v.parse(v.object({ id_token: v.string() }), await response.json())
  return { clientId, idToken, nonce, now, request: fake.fetch }
}

describe("ChatGPT identity validation", () => {
  it("verifies a signed identity against local JWKS", async () => {
    await expect(verifyChatGPTIdentity(await identityAttempt())).resolves.toEqual({ id: "test-account", email: "test@example.com" })
  })

  it.each([
    { iss: "https://other.example" },
    { aud: "another-client" },
    { exp: 1 },
    { iat: 4_000_000_000 },
    { nonce: "another-attempt" },
    { sub: "" },
    { azp: "another-client" },
    { nbf: 4_000_000_000 },
  ])("rejects untrusted claims %#", async (claims) => {
    await expect(verifyChatGPTIdentity(await identityAttempt(claims))).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_IDENTITY" })
  })

  it("rejects an invalid signature without leaking the ID token", async () => {
    const input = await identityAttempt({}, true)
    const failure: unknown = await verifyChatGPTIdentity(input).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "CONNECTIONS_CHATGPT_IDENTITY" })
    expect(String(failure)).not.toContain(input.idToken)
    expect(JSON.stringify(failure)).not.toContain(input.idToken)
  })

  it("rejects a different saved account", async () => {
    await expect(verifyChatGPTIdentity({ ...await identityAttempt(), subject: "original-account" })).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_IDENTITY" })
  })

  it("requires the ID token and the original nonce", async () => {
    const input = await identityAttempt()
    await expect(verifyChatGPTIdentity({ ...input, idToken: undefined })).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_IDENTITY" })
    await expect(verifyChatGPTIdentity({ ...input, nonce: "" })).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_IDENTITY" })
  })
})
