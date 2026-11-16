import { generateKeyPairSync } from "node:crypto"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { github } from "../src/channels.ts"
import { forgeGitEnvironment, readForgeAccess } from "../src/internal/forge-access.ts"

import type { FakeGitHub } from "../../workspace/test/fake-github.ts"
import type { AgentCallbackContext } from "../src/types.ts"

// Each test gets its own App key, because Forge caches installation tokens per App and private key.
let privateKey: string
let fake: FakeGitHub
let minted: Record<string, number>
let tokenStatus: number

beforeEach(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  minted = {}
  tokenStatus = 201
  fake = createFakeGitHub({ owner: "acme", repo: "web" })
  fake.respond((request) => {
    const tokens = request.path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)
    if (request.method === "POST" && tokens) {
      // GitHub checks the App JWT on this request.
      if (!request.headers.get("authorization")?.startsWith("Bearer ey")) return Response.json({ message: "A JSON web token could not be decoded" }, { status: 401 })
      if (tokenStatus !== 201) return Response.json({ message: "Bad credentials" }, { status: tokenStatus })
      const installation = tokens[1]!
      minted[installation] = (minted[installation] ?? 0) + 1
      return Response.json({ token: `ghs_${installation}_${minted[installation]}`, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, { status: 201 })
    }
    if (request.path === "/repos/other/api/installation") return Response.json({ id: 31 })
    return undefined
  })
  vi.stubEnv("VITEHUB_GITHUB_APP_INSTALLATIONS", JSON.stringify({ acme: 77 }))
  // Forge access falls back to the Server Env token when the App fails, so the tests run without one.
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function context(): AgentCallbackContext {
  // SAFETY: forge access reads Server Env and the abort signal only.
  return { memo: (_key: string, create: () => unknown) => create(), runtime: "unknown", waitUntil: () => {} } as unknown as AgentCallbackContext
}

it("mints the github() Channel App tokens through useForge() and the fake GitHub API", async () => {
  const channel = github({ app: { appId: "4242", privateKey, fetch: fake.fetch } })
  const access = readForgeAccess(channel)
  expect(access).toBeTypeOf("function")

  // Server Env routes the owner `acme` to installation 77, so no installation lookup.
  await expect(access!(context(), { repository: "acme/web" })).resolves.toMatchObject({ token: "ghs_77_1" })
  // Forge caches the token for the next request.
  await expect(access!(context(), { repository: "acme/web" })).resolves.toMatchObject({ token: "ghs_77_1" })
  // An owner without a route asks GitHub which installation reaches the repository.
  await expect(access!(context(), { repository: "other/api" })).resolves.toMatchObject({ token: "ghs_31_1" })
  expect(fake.requests.filter(request => request.path === "/repos/acme/web/installation")).toHaveLength(0)

  // git and gh keep the token for the run, so they ask for one that lasts 55 minutes. The cached token lasts less.
  const env = await forgeGitEnvironment(context(), channel, { repository: "acme/web" })
  expect(env.GH_TOKEN).toBe("ghs_77_1")
  const later = await access!(context(), { repository: "acme/web", minLifetime: 2 * 60 * 60_000 })
  expect(later?.token).toBe("ghs_77_2")
  expect(minted).toEqual({ 31: 1, 77: 2 })
})

it("turns a GitHub token error into AGENT_R0350 with the Forge error as its cause", async () => {
  tokenStatus = 401
  const channel = github({ app: { appId: "4242", privateKey, fetch: fake.fetch, installationId: 9 } })
  const access = readForgeAccess(channel)

  await expect(access!(context(), { repository: "acme/web" })).rejects.toMatchObject({
    code: "AGENT_R0350",
    cause: { code: "FORGE_REQUEST_FAILED" },
  })
})

// Installation routing is lower priority than explicit Channel and webhook settings.
it.each(["explicit", "webhook"])("ignores invalid unused Server Env routing for %s installation", async (source) => {
  vi.stubEnv("VITEHUB_GITHUB_INSTALLATION_ID", "7")
  vi.stubEnv("VITEHUB_GITHUB_APP_OWNER", "")
  vi.stubEnv("VITEHUB_GITHUB_APP_INSTALLATIONS", "invalid json")
  const channel = github({ app: { appId: "4242", privateKey, fetch: fake.fetch, installationId: 9 } })
  const callback = source === "explicit" ? context() : {
    ...context(),
    effect: { payload: { github: { owner: "acme", repo: "web", issueNumber: 1, commentId: 2, pullRequestUrl: "https://github.com/acme/web/pull/1", installationId: 12 } } },
    input: {},
  }
  await expect(readForgeAccess(channel)!(callback, { repository: "acme/web" })).resolves.toMatchObject({ token: source === "explicit" ? "ghs_9_1" : "ghs_12_1" })
})

it("still validates Server Env routing when it selects the installation", async () => {
  vi.stubEnv("VITEHUB_GITHUB_INSTALLATION_ID", "7")
  vi.stubEnv("VITEHUB_GITHUB_APP_OWNER", "")
  const channel = github({ app: { appId: "4242", privateKey, fetch: fake.fetch } })
  await expect(readForgeAccess(channel)!(context(), { repository: "acme/web" })).rejects.toMatchObject({ code: "FORGE_INVALID_ENV" })
})
