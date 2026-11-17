import { H3Event } from "h3"
import { installStandardContext } from "@vite-hub/runtime/internal/h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import definition from "#vitehub/auth/definition"
import { handleAuthRequest, resetAuth, signOut } from "../src/internal/server.ts"

const stored = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }))

// `signOut()` uses the discovered Auth Definition, as an app route does.
vi.mock("#vitehub/auth/definition", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory")
  const { defineFixedAuth } = await import("./fixed-auth.ts")
  const { genericOAuth } = await import("better-auth/plugins")
  return {
    default: defineFixedAuth({
      emailAndPassword: { enabled: true },
      plugins: [genericOAuth({ config: [{
        providerId: "company", clientId: "company-client", clientSecret: "company-secret",
        authorizationUrl: "https://id.example/authorize", tokenUrl: "https://id.example/token",
        endSessionEndpoint: "https://id.example/logout",
      }] })],
      database: memoryAdapter(stored.db),
      secret: "vitehub-server-sign-out-secret-5b7d1e9c3a",
    }),
  }
})

const origin = "http://localhost:3000"

afterEach(() => {
  resetAuth()
})

async function signUp(): Promise<string> {
  Object.assign(stored.db, { account: [], session: [], user: [], verification: [] })
  const response = await handleAuthRequest(definition!, new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(response.status).toBe(200)
  return response.headers.getSetCookie().map(cookie => cookie.split(";")[0]).filter(pair => !pair?.endsWith("=")).join("; ")
}

function cleared(response: Response): string[] {
  return response.headers.getSetCookie().filter(cookie => /Max-Age=0/i.test(cookie)).map(cookie => cookie.split("=", 1)[0]!)
}

describe("signOut()", () => {
  it("ends the session of a GET /logout request and redirects with the cleared cookies", async () => {
    const cookie = await signUp()
    expect(stored.db.session).toHaveLength(1)
    // Quiver's GET /logout route: a link in the page, no JSON POST.
    const event = new H3Event(new Request(`${origin}/logout`, { headers: { accept: "text/html", cookie } }))
    installStandardContext(event)
    const response = await signOut(event, { redirectTo: "/login" })

    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/login")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(cleared(response)).toEqual(expect.arrayContaining(["better-auth.session_token", "vitehub_session"]))
    expect(stored.db.session).toHaveLength(0)

    const session = await handleAuthRequest(definition!, new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }))
    expect(await session.json()).toBeNull()
  })

  it("answers 204 without redirectTo, and the same for a request without a session", async () => {
    const cookie = await signUp()
    const response = await signOut(new Request(`${origin}/api/account/delete`, { headers: { cookie }, method: "POST" }))
    expect(response.status).toBe(204)
    expect(cleared(response)).toContain("better-auth.session_token")

    const signedOut = await signOut(new Request(`${origin}/logout`), { redirectTo: "/" })
    expect(signedOut.status).toBe(303)
    expect(signedOut.headers.get("location")).toBe("/")
  })

  it.each(["/login", undefined])("visits provider logout with callback %s and clears the local session", async (redirectTo) => {
    const cookie = await signUp()
    stored.db.account!.push({
      id: "company-account", accountId: "ada-company", providerId: "company",
      userId: stored.db.user![0]!.id, idToken: "provider-id-token",
      createdAt: new Date(), updatedAt: new Date(),
    })
    const response = await signOut(new Request(`${origin}/logout`, { headers: { cookie } }), { redirectTo })
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location")!)
    expect(location.origin + location.pathname).toBe("https://id.example/logout")
    expect(location.searchParams.get("post_logout_redirect_uri")).toBe(redirectTo ? `${origin}${redirectTo}` : null)
    expect(location.searchParams.get("id_token_hint")).toBe("provider-id-token")
    expect(cleared(response)).toEqual(expect.arrayContaining(["better-auth.session_token", "vitehub_session"]))
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(stored.db.session).toHaveLength(0)
  })

  it.each(["https://evil.test/", "//evil.test/", "/\\evil.test", "login", "/\t/evil.test", "/\n/evil.test", "/\r/evil.test"])("refuses %s as redirectTo, so a query value cannot open another site", async (redirectTo) => {
    const cookie = await signUp()
    const request = new Request(`${origin}/logout?${new URLSearchParams({ redirect: redirectTo })}`, { headers: { cookie } })
    const destination = new URL(request.url).searchParams.get("redirect")!
    await expect(signOut(request, { redirectTo: destination })).rejects.toMatchObject({ code: "AUTH_SIGN_OUT_REDIRECT_INVALID" })
    expect(stored.db.session).toHaveLength(1)
  })
})
