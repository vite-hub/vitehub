import { generateKeyPairSync } from "node:crypto"

import { fixtureFetch } from "forges/testing"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CodeHostResponseError,
  codeHostErrorStatus,
  codeHostProvider,
  githubAppCredentials,
} from "../src/internal/code-host.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

function privateKeys(type: "pkcs1" | "pkcs8") {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return privateKey.export({ format: "pem", type }).toString()
}

describe("internal Code Host client", () => {
  it("caches installation tokens and refreshes them when asked", async () => {
    const key = privateKeys("pkcs8")
    const fixture = fixtureFetch([
      {
        request: { method: "POST", url: "https://api.github.com/app/installations/42/access_tokens" },
        response: { status: 201, body: { token: "first", expires_at: new Date(Date.now() + 3_600_000).toISOString() } },
      },
    ])
    const credentials = githubAppCredentials({ appId: 123, privateKey: key, fetch: fixture.fetch as typeof fetch })

    await expect(credentials.installationToken(42)).resolves.toMatchObject({ token: "first" })
    await expect(credentials.installationToken(42)).resolves.toMatchObject({ token: "first" })
    await expect(credentials.installationToken(42, { refresh: true })).resolves.toMatchObject({ token: "first" })
    expect(fixture.calls.filter(call => call.method === "POST")).toHaveLength(2)
  })

  it("renews tokens at the 60-second expiry margin", async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    try {
      let calls = 0
      const fetcher: typeof fetch = async () => Response.json({ token: `token-${++calls}`, expires_at: new Date(now + 120_000).toISOString() })
      const credentials = githubAppCredentials({ appId: 1, privateKey: privateKeys("pkcs8"), fetch: fetcher })
      await expect(credentials.installationToken(1)).resolves.toMatchObject({ token: "token-1" })
      clock.mockReturnValue(now + 59_999)
      await expect(credentials.installationToken(1)).resolves.toMatchObject({ token: "token-1" })
      clock.mockReturnValue(now + 60_000)
      await expect(credentials.installationToken(1)).resolves.toMatchObject({ token: "token-2" })
      expect(calls).toBe(2)
    }
    finally {
      clock.mockRestore()
    }
  })

  it("refreshes one installation without dropping the token of another", async () => {
    const key = privateKeys("pkcs8")
    const issued = new Map<string, number>()
    const fetcher: typeof fetch = async (input) => {
      const installation = String(input).split("/").at(-2)!
      const generation = (issued.get(installation) ?? 0) + 1
      issued.set(installation, generation)
      return Response.json({ token: `${installation}-${generation}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    }
    const credentials = githubAppCredentials({ appId: 321, privateKey: key, fetch: fetcher })
    await credentials.installationToken(1)
    await credentials.installationToken(2)
    await expect(credentials.installationToken(1, { refresh: true })).resolves.toMatchObject({ token: "1-2" })
    await expect(credentials.installationToken(2)).resolves.toMatchObject({ token: "2-1" })
  })

  it("does not share cached tokens between fetch functions", async () => {
    const key = privateKeys("pkcs8")
    const response = (token: string): typeof fetch => async () => Response.json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    await expect(githubAppCredentials({ appId: 654, privateKey: key, fetch: response("first") }).installationToken(5)).resolves.toMatchObject({ token: "first" })
    await expect(githubAppCredentials({ appId: 654, privateKey: key, fetch: response("second") }).installationToken(5)).resolves.toMatchObject({ token: "second" })
  })

  it("exposes the HTTP status and a missing token so callers keep their diagnostic codes", async () => {
    const key = privateKeys("pkcs8")
    const failed = githubAppCredentials({ appId: 987, privateKey: key, fetch: async () => Response.json({ message: "Bad credentials" }, { status: 401 }) })
    const error: unknown = await failed.installationToken(8).catch((reason: unknown) => reason)
    expect(codeHostErrorStatus(error)).toBe(401)
    const empty = githubAppCredentials({ appId: 988, privateKey: key, fetch: async () => Response.json({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }) })
    await expect(empty.installationToken(8)).rejects.toBeInstanceOf(CodeHostResponseError)
  })

  it.each(["pkcs1", "pkcs8"] as const)("signs %s private keys", async type => {
    const fixture = fixtureFetch([
      {
        request: { method: "POST", url: "https://api.github.com/app/installations/7/access_tokens" },
        response: { status: 201, body: { token: "token", expires_at: new Date(Date.now() + 3_600_000).toISOString() } },
      },
    ])
    await expect(githubAppCredentials({ appId: 9, privateKey: privateKeys(type), fetch: fixture.fetch as typeof fetch }).installationToken(7)).resolves.toMatchObject({ token: "token" })
    expect(fixture.calls[0]?.authorization).toMatch(/^Bearer /)
  })

  it("resolves app metadata and installation ids", async () => {
    const fixture = fixtureFetch([
      { request: { method: "GET", url: "https://api.github.com/app" }, response: { status: 200, body: { id: 12, slug: "vitehub" } } },
      { request: { method: "GET", url: "https://api.github.com/repos/acme/app/installation" }, response: { status: 200, body: { id: 33 } } },
    ])
    const credentials = githubAppCredentials({ appId: 12, privateKey: privateKeys("pkcs8"), fetch: fixture.fetch as typeof fetch })
    await expect(credentials.app()).resolves.toEqual({ id: 12, slug: "vitehub", login: "vitehub[bot]" })
    await expect(credentials.installation("acme/app")).resolves.toBe(33)
  })

  it("maps a missing installation to the existing diagnostic", async () => {
    const fixture = fixtureFetch([
      { request: { method: "GET", url: "https://api.github.com/repos/acme/app/installation" }, response: { status: 404, body: {} } },
    ])
    await expect(githubAppCredentials({ appId: 12, privateKey: privateKeys("pkcs1"), fetch: fixture.fetch as typeof fetch }).installation("acme/app"))
      .rejects.toMatchObject({ code: "AGENT_R0757" })
  })

  it("uses the GitLab and Forgejo API paths and token auth", async () => {
    const gitlab = fixtureFetch([{ request: { method: "GET", url: "https://gitlab.com/api/v4/projects/acme%2Fapp" }, response: { status: 200, body: {} } }])
    const forgejo = fixtureFetch([{ request: { method: "GET", url: "https://codeberg.org/api/v1/repos/acme/app" }, response: { status: 200, body: {} } }])
    await (await codeHostProvider({ host: "gitlab", token: "gitlab-token", fetch: gitlab.fetch as typeof fetch })).request("GET", "/projects/acme%2Fapp")
    await (await codeHostProvider({ host: "forgejo", token: "forgejo-token", fetch: forgejo.fetch as typeof fetch })).request("GET", "/repos/acme/app")
    expect(gitlab.calls[0]?.authorization).toBe("Bearer gitlab-token")
    expect(forgejo.calls[0]?.authorization).toBe("token forgejo-token")
  })

  it("blocks writes in read-only mode", async () => {
    const provider = await codeHostProvider({ host: "github", readOnly: true })
    expect(provider.can("threads.comment", "pull_request")).toBe(false)
    await expect(provider.threads.comment({ forge: "github", instance: "github.com", repo: { forge: "github", instance: "github.com", owner: "acme", name: "app" }, kind: "pull_request", number: "1" }, "body"))
      .rejects.toThrow()
  })

  it("cancels an in-flight token fetch without cancelling another caller", async () => {
    const controller = new AbortController()
    let markStarted!: (signal: AbortSignal | null | undefined) => void
    const started = new Promise<AbortSignal | null | undefined>((resolve) => { markStarted = resolve })
    let calls = 0
    const fetcher: typeof fetch = async (_input, init) => {
      calls++
      if (calls > 1) return Response.json({ token: "retry", expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      markStarted(init?.signal)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    }
    const credentials = githubAppCredentials({ appId: 1, privateKey: privateKeys("pkcs8"), fetch: fetcher })
    const pending = credentials.installationToken(1, { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow("cancelled")
    const signal = await started
    const other = credentials.installationToken(1)
    controller.abort(new Error("cancelled"))
    await rejected
    expect(signal?.aborted).toBe(true)
    await expect(other).resolves.toMatchObject({ token: "retry" })
    await expect(credentials.installationToken(1)).resolves.toMatchObject({ token: "retry" })
    expect(calls).toBe(2)
  })

  it("rejects an aborted token request", async () => {
    const controller = new AbortController()
    const fetcher: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
    const pending = githubAppCredentials({ appId: 1, privateKey: privateKeys("pkcs8"), fetch: fetcher }).installationToken(1, { signal: controller.signal })
    controller.abort(new Error("cancelled"))
    await expect(pending).rejects.toThrow("cancelled")
  })
})
