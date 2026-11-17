import { readFileSync } from "node:fs"

import { afterAll, describe, expect, it, vi } from "vitest"

// Run the demo's real Auth Definition on Auth's source, with its users in memory in place of the `users` Database.
vi.mock("vite-hub/auth", () => import("../../auth/src/index.ts"))
vi.mock("vite-hub/auth/database", () => ({ authDatabase: () => "memory" }))
vi.mock("vite-hub/cms/access", () => import("../../cms/src/access.ts"))

import { createAuthForRequest, resetAuth } from "../../auth/src/internal/server.ts"
import auth from "../playground/server/auth.ts"

const origin = "https://docs-demo.vitehub.dev"
const onmax = 22072217

/** The `VITEHUB_ADMINS` that the `docs-demo deploy` job gives the Worker. */
function deployedAdmins() {
  const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
  return /^\s*DOCS_DEMO_VITEHUB_ADMINS: (\S+)$/m.exec(workflow)?.[1]
}

/** GitHub's token, user, and email endpoints, answering for one GitHub account. */
function stubGitHub(id: number, email: string) {
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const [input] = args
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "token", token_type: "bearer", scope: "read:user,user:email" })
    if (url.href === "https://api.github.com/user") return Response.json({ id, login: email.split("@")[0], name: email, email, avatar_url: "" })
    if (url.href === "https://api.github.com/user/emails") return Response.json([{ email, primary: true, verified: true, visibility: "public" }])
    return await realFetch(...args)
  })
}

function cookieHeader(response: Response) {
  return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
}

/** Signs in with GitHub through Better Auth's OAuth flow, and returns the role of the signed-in user. */
async function signInWithGitHub(id: number, email: string) {
  stubGitHub(id, email)
  const provider = createAuthForRequest(auth, new Request(origin))
  const start = await provider.handler(new Request(`${origin}/api/auth/sign-in/social`, {
    body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
  expect(start.status).toBe(200)
  const { url } = await start.json() as { url: string }
  const state = new URL(url).searchParams.get("state")
  const callback = await provider.handler(new Request(`${origin}/api/auth/callback/github?code=code&state=${state}`, { headers: { cookie: cookieHeader(start) } }))
  expect(callback.headers.get("location")).not.toContain("error")
  const found = await (await provider.$context).internalAdapter.findUserByEmail(email)
  return found ? Reflect.get(found.user, "role") : undefined
}

describe("the demo's admin role", () => {
  afterAll(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    resetAuth()
  })

  it("comes from VITEHUB_ADMINS, which the deploy sets to onmax's GitHub account", async () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "client")
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret")

    // The source names no admin: without the variable, onmax signs in as a plain user.
    expect(await signInWithGitHub(onmax, "onmax@example.com")).toBe("user")

    const admins = deployedAdmins()
    expect(admins).toBe(`github:${onmax}`)
    vi.stubEnv("VITEHUB_ADMINS", admins)
    resetAuth()
    expect(await signInWithGitHub(onmax, "onmax@example.com")).toBe("admin")
    expect(await signInWithGitHub(1, "guest@example.com")).toBe("user")
  })
})
