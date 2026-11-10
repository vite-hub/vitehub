import type { JSONWebKeySet, JWTPayload, JWTVerifyOptions } from "jose"

/**
 * Check the signature and claims of an MCP access token against the keys of the app's Auth. Only builds with Console
 * OAuth pass it to `installConsoleAccess()`, so other builds ship without jose. It loads jose on the first token.
 */
export async function verifyConsoleJwt(token: string, jwks: JSONWebKeySet, options: JWTVerifyOptions): Promise<JWTPayload> {
  const { createLocalJWKSet, jwtVerify } = await import("jose")
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), options)
  return payload
}
