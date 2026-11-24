import { describe, expect, it } from "vitest"

import { createConsoleKeyPair, readConsolePublicKeys } from "../src/console-signature.ts"
import { createSiteState, isSitePath, siteStateHash, siteTokenUrl, siteVisitUrl, signSiteToken, verifySiteToken } from "../src/site-token.ts"

import type { SiteTokenClaims } from "../src/site-token.ts"

const now = 1_794_400_000_000
const origin = "https://app.example.com"
const name = "CONSOLE_3F9A12BC"

async function link() {
  const pair = await createConsoleKeyPair()
  const keys = readConsolePublicKeys({ [`VITEHUB_CONSOLE_KEY_${name}`]: pair.publicKey })
  if (!(keys instanceof Map)) throw new Error(keys.message)
  return { key: { name, privateKey: pair.privateKey }, keys }
}

async function visit(claims: Partial<Omit<SiteTokenClaims, "iat" | "exp">> = {}) {
  const { key, keys } = await link()
  const state = createSiteState()
  const token = await signSiteToken({
    key,
    claims: { aud: `${origin}/portal`, sub: "user-1", name: "Ada", email: "ada@example.com", roles: ["console", "comments-write"], kind: "site", path: "/docs", state: await siteStateHash(state), ...claims },
    now,
  })
  return { key, keys, state, token }
}

describe("Site access tokens", () => {
  it("signs in the Console and verifies in the app with the public key of the link", async () => {
    const { keys, state, token } = await visit()
    const callback = new URL(siteTokenUrl(`${origin}/portal/`, token))
    expect(callback.pathname).toBe("/portal/_vitehub/site")
    const result = await verifySiteToken({ token: callback.searchParams.get("token")!, keys, origin, state, now: now + 30_000 })
    expect(result).toEqual({
      ok: true,
      key: name,
      destination: `${origin}/docs`,
      claims: { aud: origin, sub: "user-1", name: "Ada", email: "ada@example.com", roles: ["console", "comments-write"], kind: "site", path: "/docs", state: await siteStateHash(state), iat: now / 1_000, exp: now / 1_000 + 60 },
    })
  })

  it("refuses a token for another origin", async () => {
    const { keys, state, token } = await visit()
    expect(await verifySiteToken({ token, keys, origin: "https://evil.example.com", state, now })).toMatchObject({ ok: false, code: "SITE_TOKEN_AUDIENCE" })
  })

  it("refuses an expired token", async () => {
    const { keys, state, token } = await visit()
    expect(await verifySiteToken({ token, keys, origin, state, now: now + 60_000 })).toMatchObject({ ok: false, code: "SITE_TOKEN_EXPIRED" })
    expect(await verifySiteToken({ token, keys, origin, state, now: now - 120_000 })).toMatchObject({ ok: false, code: "SITE_TOKEN_EXPIRED" })
  })

  it("keeps a token for `lifetime` seconds after it was signed, for a session cookie", async () => {
    const { keys, state, token } = await visit()
    const hours = 12 * 60 * 60
    expect(await verifySiteToken({ token, keys, origin, state, lifetime: hours, now: now + 60_000 })).toMatchObject({ ok: true })
    expect(await verifySiteToken({ token, keys, origin, state, lifetime: hours, now: now + hours * 1_000 - 1_000 })).toMatchObject({ ok: true })
    expect(await verifySiteToken({ token, keys, origin, state, lifetime: hours, now: now + hours * 1_000 })).toMatchObject({ ok: false, code: "SITE_TOKEN_EXPIRED" })
  })

  it("refuses a token for the state of another browser", async () => {
    const { keys, token } = await visit()
    expect(await verifySiteToken({ token, keys, origin, state: createSiteState(), now })).toMatchObject({ ok: false, code: "SITE_TOKEN_STATE" })
    expect(await verifySiteToken({ token, keys, origin, state: "", now })).toMatchObject({ ok: false, code: "SITE_TOKEN_STATE" })
  })

  it("refuses a token of another key", async () => {
    const { state, token } = await visit()
    const other = await link()
    expect(await verifySiteToken({ token, keys: other.keys, origin, state, now })).toMatchObject({ ok: false, code: "SITE_TOKEN_SIGNATURE" })
    expect(await verifySiteToken({ token, keys: new Map([["CI", other.keys.get(name)!]]), origin, state, now })).toMatchObject({ ok: false, code: "SITE_TOKEN_KEY_UNKNOWN" })
  })

  it("refuses a kind that the route does not accept", async () => {
    const { keys, state, token } = await visit({ kind: "impersonate" })
    expect(await verifySiteToken({ token, keys, origin, state, now })).toMatchObject({ ok: false, code: "SITE_TOKEN_KIND" })
    expect(await verifySiteToken({ token, keys, origin, state, now, kinds: ["impersonate"] })).toMatchObject({ ok: true, claims: { kind: "impersonate" } })
  })

  it("refuses changed and malformed tokens", async () => {
    const { keys, state, token } = await visit()
    const [version, key, payload, signature] = token.split(".")
    const claims: unknown = JSON.parse(Buffer.from(payload!, "base64url").toString())
    const raised = Buffer.from(JSON.stringify({ ...Object(claims), roles: ["console", "comments-delete"] })).toString("base64url")
    expect(await verifySiteToken({ token: [version, key, raised, signature].join("."), keys, origin, state, now })).toMatchObject({ ok: false, code: "SITE_TOKEN_SIGNATURE" })
    const unknownKind = Buffer.from(JSON.stringify({ ...Object(claims), kind: "admin" })).toString("base64url")
    for (const value of ["", "vst1", `vst2.${key}.${payload}.${signature}`, [version, key, unknownKind, signature].join("."), `${token}.x`, "x".repeat(9_000)]) {
      expect(await verifySiteToken({ token: value, keys, origin, state, now }), value.slice(0, 20)).toMatchObject({ ok: false, code: "SITE_TOKEN_MALFORMED" })
    }
  })

  it("hashes the state, so only the hash leaves the app", async () => {
    const state = createSiteState()
    expect(state).toMatch(/^[\w-]{43}$/)
    expect(await siteStateHash(state)).toMatch(/^[\w-]{43}$/)
    expect(await siteStateHash(state)).not.toBe(state)
    const visitUrl = new URL(siteVisitUrl({ console: "https://console.vitehub.dev/", app: `${origin}/portal`, state: await siteStateHash(state), path: "/docs" }))
    expect(`${visitUrl.origin}${visitUrl.pathname}`).toBe("https://console.vitehub.dev/visit")
    expect(Object.fromEntries(visitUrl.searchParams)).toEqual({ app: `${origin}/portal`, state: await siteStateHash(state), return: "/docs" })
    expect([isSitePath("/docs?a=1"), isSitePath("//evil.example"), isSitePath("https://evil.example"), isSitePath("/\\evil")]).toEqual([true, false, false, false])
  })

  it("refuses control characters in a path, and a token path outside the app URL", async () => {
    expect(["/\t/evil.example", "/\n/evil.example", "/docs\u007f"].map(isSitePath)).toEqual([false, false, false])
    const { keys, state, token } = await visit({ path: "/../admin" })
    expect(await verifySiteToken({ token, keys, origin: `${origin}/portal`, state, now })).toMatchObject({ ok: false, code: "SITE_TOKEN_PATH" })
    expect(await verifySiteToken({ token, keys, origin, state, now })).toMatchObject({ ok: true, destination: `${origin}/admin` })
    const inside = await visit({ path: "/docs?tab=1" })
    expect(await verifySiteToken({ token: inside.token, keys: inside.keys, origin: `${origin}/portal/`, state: inside.state, now })).toMatchObject({ ok: true, destination: `${origin}/portal/docs?tab=1` })
    const control = await visit({ path: "/\t/evil.example" })
    expect(await verifySiteToken({ token: control.token, keys: control.keys, origin, state: control.state, now })).toMatchObject({ ok: false, code: "SITE_TOKEN_PATH" })
  })

  it("refuses to sign a token that the app would refuse for its length", async () => {
    await expect(visit({ path: `/${"\u8a9e".repeat(2_047)}` })).rejects.toThrow(/8192/)
  })
})
