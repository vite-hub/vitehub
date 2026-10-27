import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { exportJWK, generateKeyPair, SignJWT } from "jose"

interface Authorization {
  challenge: string
  clientId: string
  nonce: string
  redirectUri: string
  scopes: string
}

/** A loopback OAuth server. Its fetch rejects destinations outside the fake's route map. */
export async function createChatGPTFake(now: () => number = Date.now) {
  const issuer = "https://auth.openai.com"
  const resource = "https://api.openai.com/v1"
  const keys = await generateKeyPair("RS256")
  const jwk = { ...await exportJWK(keys.publicKey), kid: "local-siwc-test", alg: "RS256", use: "sig" }
  const authorizations = new Map<string, Authorization>()
  const refreshTokens = new Set<string>()
  const usedRefreshTokens = new Set<string>()
  const calls: Array<{ path: string, method: string, parameters: URLSearchParams }> = []
  const state = {
    subject: "test-account",
    email: "test@example.com",
    scopes: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    expiresIn: 3600,
    tokenError: undefined as string | undefined,
    tokenStatus: 400,
    idClaims: {} as Record<string, unknown>,
    omit: [] as string[],
    signWithWrongKey: false,
    responseError: undefined as { code: string, status: number } | undefined,
    requests: [] as Record<string, unknown>[],
    revoked: 0,
    registrations: 0,
    refreshes: 0,
  }

  async function token(authorization: Pick<Authorization, "clientId" | "nonce">) {
    const refreshToken = `test-refresh-${randomUUID()}`
    refreshTokens.add(refreshToken)
    const signingKey = state.signWithWrongKey ? (await generateKeyPair("RS256")).privateKey : keys.privateKey
    const idToken = await new SignJWT({
      email: state.email,
      nonce: authorization.nonce,
      ...state.idClaims,
    }).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(typeof state.idClaims.iss === "string" ? state.idClaims.iss : issuer)
      .setAudience(typeof state.idClaims.aud === "string" ? state.idClaims.aud : authorization.clientId)
      .setSubject(typeof state.idClaims.sub === "string" ? state.idClaims.sub : state.subject)
      .setIssuedAt(typeof state.idClaims.iat === "number" ? state.idClaims.iat : Math.floor(now() / 1000))
      .setExpirationTime(typeof state.idClaims.exp === "number" ? state.idClaims.exp : Math.floor(now() / 1000) + 3600)
      .sign(signingKey)
    return Object.fromEntries(Object.entries({
      access_token: `test-access-${randomUUID()}`,
      refresh_token: refreshToken,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: state.expiresIn,
      scope: state.scopes,
    }).filter(([key]) => !state.omit.includes(key)))
  }

  const server = createServer(async (request, reply) => {
    try {
      const url = new URL(request.url ?? "/", issuer)
      let body = ""
      for await (const chunk of request) body += String(chunk)
      const parameters = request.method === "POST" ? new URLSearchParams(body) : url.searchParams
      calls.push({ path: url.pathname, method: request.method ?? "GET", parameters })
      const json = (value: unknown, status = 200) => {
        reply.writeHead(status, { "content-type": "application/json" })
        reply.end(JSON.stringify(value))
      }
      if (url.pathname === "/.well-known/jwks.json") return json({ keys: [jwk] })
      if (url.pathname === "/.well-known/openid-configuration") return json({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        authorization_endpoint: `${issuer}/api/accounts/authorize`,
        token_endpoint: `${issuer}/api/accounts/oauth/token`,
        revocation_endpoint: `${issuer}/api/accounts/oauth/revoke`,
      })
      if (url.pathname === "/api/accounts/authorize") {
        const newRegistration = parameters.get("client_id") === "dynamic_agent_client"
        const clientId = newRegistration ? `oaiapp_test_${++state.registrations}` : parameters.get("client_id") ?? ""
        const code = randomUUID()
        const redirectUri = parameters.get("redirect_uri") ?? ""
        authorizations.set(code, { clientId, redirectUri, nonce: parameters.get("nonce") ?? "", challenge: parameters.get("code_challenge") ?? "", scopes: parameters.get("scope") ?? "" })
        const callback = new URL(redirectUri)
        callback.searchParams.set("state", parameters.get("state") ?? "")
        callback.searchParams.set("code", code)
        if (newRegistration) callback.searchParams.set("client_id", clientId)
        reply.writeHead(302, { location: callback.href })
        return reply.end()
      }
      if (url.pathname === "/api/accounts/oauth/token") {
        if (state.tokenError) return json({ error: state.tokenError, error_description: "test-secret-do-not-echo" }, state.tokenStatus)
        if (parameters.get("resource") !== resource) return json({ error: "invalid_target" }, 400)
        if (parameters.has("client_secret")) return json({ error: "invalid_client" }, 400)
        if (parameters.get("grant_type") === "authorization_code") {
          const code = parameters.get("code") ?? ""
          const authorization = authorizations.get(code)
          authorizations.delete(code)
          const challenge = createHash("sha256").update(parameters.get("code_verifier") ?? "").digest("base64url")
          if (!authorization || challenge !== authorization.challenge || parameters.get("client_id") !== authorization.clientId || parameters.get("redirect_uri") !== authorization.redirectUri) return json({ error: "invalid_grant" }, 400)
          return json(await token(authorization))
        }
        const refreshToken = parameters.get("refresh_token") ?? ""
        if (usedRefreshTokens.has(refreshToken)) return json({ error: "refresh_token_reused" }, 400)
        if (!refreshTokens.delete(refreshToken)) return json({ error: "invalid_refresh_token" }, 400)
        usedRefreshTokens.add(refreshToken)
        state.refreshes += 1
        return json(await token({ clientId: parameters.get("client_id") ?? "", nonce: "refresh" }))
      }
      if (url.pathname === "/api/accounts/oauth/revoke") {
        if (!parameters.get("client_id")?.startsWith("oaiapp_") || parameters.get("token_type_hint") !== "refresh_token") return json({ error: "invalid_request" }, 400)
        refreshTokens.delete(parameters.get("token") ?? "")
        state.revoked += 1
        reply.writeHead(200)
        return reply.end()
      }
      if (url.pathname === "/v1/models") return json({ models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1", visibility: "list" },
        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
      ] })
      if (url.pathname === "/v1/responses") {
        const parsed: unknown = JSON.parse(body)
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json({ error: { code: "invalid_request" } }, 400)
        state.requests.push(Object.fromEntries(Object.entries(parsed)))
        if (state.responseError) return json({ error: { code: state.responseError.code, message: "test-secret-do-not-echo", param: "tools" } }, state.responseError.status)
        const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello from the local ChatGPT fake.", annotations: [] }] }
        const response = { id: "resp_test", object: "response", created_at: Math.floor(now() / 1000), status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
        reply.writeHead(200, { "content-type": "text/event-stream" })
        for (const event of [
          { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
          { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
          { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0]!.text },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response },
        ]) reply.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        return reply.end()
      }
      return json({ error: "unexpected_fake_route" }, 404)
    }
    catch {
      reply.writeHead(500)
      reply.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fake OAuth listener did not bind")
  const origin = `http://127.0.0.1:${address.port}`
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (![issuer, "https://api.openai.com", origin].includes(url.origin)) throw new Error("The fake refuses external requests")
    return await fetch(`${origin}${url.pathname}${url.search}`, { ...init, redirect: "manual" })
  }
  return {
    calls,
    fetch: fakeFetch,
    origin,
    state,
    async callback(url: string) {
      const response = await fakeFetch(url)
      const location = response.headers.get("location")
      if (!location) throw new Error("Fake authorization did not return a callback")
      return new URL(location)
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
