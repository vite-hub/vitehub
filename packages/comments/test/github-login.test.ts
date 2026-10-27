import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defaultPolicy, defineComments } from "../src/index.ts"
import { createCommentsGitHubLogin, safeReturn } from "../src/runtime/github-login.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { defineCommentsPlugin } from "../src/runtime/plugin.ts"
import { anchor, createDatabase } from "./harness.ts"

import type { H3Event } from "h3"
import type { CommentsGitHubLogin } from "../src/runtime/github-login.ts"
import type { CommentsHandlerOptions } from "../src/runtime/handler.ts"
import type { CommentsUser, DefineCommentsOptions } from "../src/types.ts"

const origin = "http://site.test"

/** A GitHub sign-in whose signed-in person the test picks. */
function fakeLogin(user: CommentsUser | null): CommentsGitHubLogin & { handled: string[] } {
  const handled: string[] = []
  return {
    handled,
    configured: () => true,
    user: async () => user,
    handle: async (_event: H3Event, path: string) => {
      handled.push(path)
      return new Response(null, { status: 204 })
    },
  }
}

async function setup(githubLogin: CommentsGitHubLogin, development = false, options: { identify?: DefineCommentsOptions["identify"], session?: CommentsHandlerOptions["session"] } = {}) {
  const comments = defineComments({ identify: options.identify })
  const database = await createDatabase()
  defineCommentsPlugin({ comments, database: () => database, overlay: "/overlay.js", development })({})
  const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false, githubLogin, session: options.session }))
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await app.fetch(new Request(`${origin}/api/_vitehub/comments${path}`, init))
    return { response, body: response.status === 204 ? undefined : await response.json() as { data?: any } }
  }
  return call
}

const ada = (write: boolean): CommentsUser => ({ id: "gh-ada", name: "Ada", image: "https://avatars.test/ada", github: { login: "ada", repository: "acme/app", write } })

describe("default policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("lets people who can push to the repository in, and other GitHub people out", () => {
    expect(defaultPolicy(ada(true))).toBe(true)
    expect(defaultPolicy(ada(false))).toBe(false)
  })

  it("keeps letting in users of the app's own sign-in", () => {
    expect(defaultPolicy({ id: "u1", name: "Grace" })).toBe(true)
  })

  it.each(["development", "production"])("denies anonymous guests without dev-server identity when NODE_ENV=%s", (environment) => {
    vi.stubEnv("NODE_ENV", environment)
    expect(defaultPolicy(null)).toBe(false)
  })

  it.each([
    { development: false, environment: "development" },
    { development: false, environment: "production" },
    { development: true, environment: "development" },
    { development: true, environment: "production" },
  ])("uses generated development=$development for guest access when NODE_ENV=$environment", async ({ development, environment }) => {
    vi.stubEnv("NODE_ENV", environment)
    const call = await setup(fakeLogin(null), development)
    const { body } = await call("/session")
    expect(body!.data.can).toEqual({ read: development, comment: development, resolve: development })
    expect((await call("/threads")).response.status).toBe(development ? 200 : 403)
    const created = await call("/threads", {
      method: "POST",
      headers: { "content-type": "application/json", "origin": origin, "x-vitehub-comments-guest-id": "g1", "x-vitehub-comments-guest-name": "Lin" },
      body: JSON.stringify({ page: "/", anchor, body: "Hello" }),
    })
    expect(created.response.status).toBe(development ? 200 : 403)
  })
})

describe("GitHub sign-in in the Comments API", () => {
  it("keeps identify authoritative when it denies a signed-in GitHub person", async () => {
    const login = fakeLogin(ada(true))
    const user = vi.spyOn(login, "user")
    const call = await setup(login, false, { identify: () => null })
    const { body } = await call("/session")
    expect(body!.data).toMatchObject({ user: null, can: { read: false } })
    expect(user).not.toHaveBeenCalled()
  })

  it.each([null, { id: "app-user", name: "Grace" }])("uses the app session before the GitHub fallback: %j", async (sessionUser) => {
    const call = await setup(fakeLogin(ada(true)), false, { session: async () => sessionUser })
    const { body } = await call("/session")
    expect(body!.data.user.id).toBe(sessionUser?.id ?? "gh-ada")
  })

  it("offers the sign-in to people who are not signed in, and keeps comment mode on", async () => {
    const call = await setup(fakeLogin(null))
    const { response, body } = await call("/session")
    expect(body!.data).toMatchObject({ user: null, can: { read: false }, signIn: { provider: "github", url: "/api/_vitehub/comments/auth/github" } })
    expect(response.headers.get("set-cookie")).toContain("vitehub-comments=1;")
  })

  it("says who is signed in when they cannot push, so they can switch accounts", async () => {
    const call = await setup(fakeLogin(ada(false)))
    const { body } = await call("/session")
    expect(body!.data).toMatchObject({ user: { id: "gh-ada", name: "Ada" }, github: { login: "ada", repository: "acme/app", write: false }, can: { read: false }, signOut: "/api/_vitehub/comments/auth/sign-out" })
    expect(body!.data.signIn).toBeUndefined()
  })

  it("lets a person who can push comment, with their GitHub picture", async () => {
    const call = await setup(fakeLogin(ada(true)))
    const { body } = await call("/session")
    expect(body!.data).toMatchObject({ user: { id: "gh-ada", name: "Ada", image: "https://avatars.test/ada" }, can: { read: true, comment: true, resolve: true } })
  })

  it("passes the auth routes to the sign-in", async () => {
    const login = fakeLogin(null)
    const call = await setup(login)
    await call("/auth/callback/github?code=1&state=2")
    expect(login.handled).toEqual(["/auth/callback/github"])
  })
})

describe("createCommentsGitHubLogin", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function event(path: string): H3Event {
    // SAFETY: The sign-in reads only the request of the event.
    return { req: new Request(`${origin}${path}`) } as H3Event
  }

  it("is off without an OAuth client, and says which variables turn it on", async () => {
    vi.stubEnv("VITEHUB_GITHUB_CLIENT_ID", "")
    const login = createCommentsGitHubLogin({ repository: "acme/app" })
    expect(login.configured()).toBe(false)
    const response = await login.handle(event("/api/_vitehub/comments/auth/github"), "/auth/github")
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).toContain("VITEHUB_GITHUB_CLIENT_ID")
  })

  it("sends people to GitHub and brings them back to the page, with no database", async () => {
    vi.stubEnv("VITEHUB_GITHUB_CLIENT_ID", "client-id")
    vi.stubEnv("VITEHUB_GITHUB_CLIENT_SECRET", "client-secret")
    vi.stubEnv("VITEHUB_SECRET", "a-test-secret-that-is-at-least-32-characters")
    const login = createCommentsGitHubLogin({ repository: "acme/app" })
    const response = await login.handle(event("/api/_vitehub/comments/auth/github?return=%2Fpricing%3Fcomments"), "/auth/github")
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get("location")!)
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(location.searchParams.get("client_id")).toBe("client-id")
    expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/api/_vitehub/comments/auth/callback/github`)
    // The OAuth state is in a cookie, because there is no database to keep it.
    expect(response.headers.getSetCookie().join("\n")).toContain("vitehub_comments")
  })

  it.each(["VITEHUB_SECRET", "NUXT_APP_SECRET"])("rejects a short %s before starting GitHub sign-in", async (name) => {
    vi.stubEnv("VITEHUB_GITHUB_CLIENT_ID", "client-id")
    vi.stubEnv("VITEHUB_GITHUB_CLIENT_SECRET", "client-secret")
    vi.stubEnv("VITEHUB_SECRET", "")
    vi.stubEnv("NUXT_APP_SECRET", "")
    vi.stubEnv(name, "a".repeat(31))
    const login = createCommentsGitHubLogin({ repository: "acme/app" })
    await expect(login.handle(event("/api/_vitehub/comments/auth/github"), "/auth/github")).rejects.toThrow("VITEHUB_SECRET must be at least 32 characters")
  })

  it("never sends people back to another site", () => {
    expect(safeReturn("/pricing?comments#comment-1")).toBe("/pricing?comments#comment-1")
    for (const value of ["//evil.test", "/\\evil.test", "https://evil.test", null]) expect(safeReturn(value)).toBe("/?comments")
  })
})
