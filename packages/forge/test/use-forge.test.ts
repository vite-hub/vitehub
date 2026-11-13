import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useForge } from "../src/index.ts"

import type { AddressInfo } from "node:net"
import type { IncomingMessage, Server } from "node:http"

interface FakeRequest {
  method: string
  path: string
  authorization: string | undefined
}

/**
 * A local GitHub API. It checks the RS256 signature of each App JWT with the App's public key, as GitHub does,
 * mints installation tokens, and reports which installation can reach each repository.
 */
class FakeGitHub {
  readonly appId = "123"
  readonly privateKey: string
  readonly requests: FakeRequest[] = []
  readonly installations = new Map([["acme/web", 42]])
  tokenStatus = 201
  private readonly publicKey: ReturnType<typeof createPublicKey>
  private minted = 0
  private server: Server | undefined
  url = ""

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    this.privateKey = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    this.publicKey = publicKey
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" })
        response.end(JSON.stringify(body))
      }
      const path = new URL(request.url ?? "/", "http://localhost").pathname
      this.requests.push({ method: request.method ?? "GET", path, authorization: request.headers.authorization })
      const installation = path.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/)
      const tokens = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/)

      if (path === "/app" || installation || tokens) {
        if (!this.validAppJwt(request)) return reply(401, { message: "A JSON web token could not be decoded" })
        if (path === "/app") return reply(200, { id: Number(this.appId), slug: "acme-bot" })
        if (installation) {
          const id = this.installations.get(installation[1]!)
          return id ? reply(200, { id }) : reply(404, { message: "Not Found" })
        }
        if (this.tokenStatus !== 201) return reply(this.tokenStatus, { message: "Bad credentials" })
        this.minted++
        return reply(201, { token: `ghs_${tokens![1]}_${this.minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      }
      if (path === "/repos/acme/web") {
        if (!request.headers.authorization?.startsWith("Bearer ghs_42_")) return reply(401, { message: "Bad credentials" })
        return reply(200, { full_name: "acme/web" })
      }
      reply(404, { message: "Not Found" })
    })
    await new Promise<void>(resolve => this.server!.listen(0, "127.0.0.1", resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.server?.close(() => resolve()) ?? resolve())
  }

  count(method: string, path: string): number {
    return this.requests.filter(request => request.method === method && request.path === path).length
  }

  private validAppJwt(request: IncomingMessage): boolean {
    const jwt = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    const [header, payload, signature] = jwt?.split(".") ?? []
    if (!header || !payload || !signature) return false
    const signed = verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), this.publicKey, Buffer.from(signature, "base64url"))
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return signed && typeof claims === "object" && claims !== null && "iss" in claims && String(claims.iss) === this.appId
  }
}

let github: FakeGitHub

// Installation tokens are cached per App and private key, so each test gets a new App.
beforeEach(async () => {
  github = new FakeGitHub()
  await github.start()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await github.stop()
})

function appEnv(extra: Record<string, string> = {}) {
  return { VITEHUB_GITHUB_APP_ID: github.appId, VITEHUB_GITHUB_PRIVATE_KEY: github.privateKey, ...extra }
}

describe("useForge() with a GitHub App", () => {
  it("mints an installation token for the repository and caches it", async () => {
    const forge = useForge({ baseUrl: github.url, env: appEnv() })
    expect(forge).toMatchObject({ kind: "github", auth: "app", baseUrl: github.url })

    const [error, token] = await forge.token({ repository: "acme/web" })
    expect(error).toBeUndefined()
    expect(token?.token).toBe("ghs_42_1")
    expect(token?.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_000_000)

    await expect(useForge({ baseUrl: github.url, env: appEnv() }).token({ repository: "acme/web" }))
      .resolves.toEqual([undefined, { token: "ghs_42_1", expiresAt: token?.expiresAt }])
    expect(github.count("POST", "/app/installations/42/access_tokens")).toBe(1)

    await expect(forge.token({ repository: "acme/web", refresh: true })).resolves.toMatchObject([undefined, { token: "ghs_42_2" }])
    expect(github.count("POST", "/app/installations/42/access_tokens")).toBe(2)
  })

  it("uses VITEHUB_GITHUB_INSTALLATION_ID for VITEHUB_GITHUB_APP_OWNER without a lookup", async () => {
    const forge = useForge({ baseUrl: github.url, env: appEnv({ VITEHUB_GITHUB_INSTALLATION_ID: "7", VITEHUB_GITHUB_APP_OWNER: "Acme" }) })

    await expect(forge.token()).resolves.toMatchObject([undefined, { token: "ghs_7_1" }])
    await expect(forge.token({ repository: "acme/web" })).resolves.toMatchObject([undefined, { token: "ghs_7_1" }])
    expect(github.count("GET", "/repos/acme/web/installation")).toBe(0)
  })

  it("routes each repository owner to its installation", async () => {
    github.installations.set("third/app", 11)
    const forge = useForge({
      baseUrl: github.url,
      env: appEnv({ VITEHUB_GITHUB_INSTALLATION_ID: "7", VITEHUB_GITHUB_APP_OWNER: "acme", VITEHUB_GITHUB_APP_INSTALLATIONS: "{\"Other\":9}" }),
    })

    await expect(forge.token({ repository: "acme/web" })).resolves.toMatchObject([undefined, { token: "ghs_7_1" }])
    await expect(forge.token({ repository: "other/api" })).resolves.toMatchObject([undefined, { token: expect.stringMatching(/^ghs_9_/) }])
    // An owner without a configured installation uses GitHub's lookup, not the fixed installation of `acme`.
    await expect(forge.token({ repository: "third/app" })).resolves.toMatchObject([undefined, { token: expect.stringMatching(/^ghs_11_/) }])
    expect(github.count("GET", "/repos/third/app/installation")).toBe(1)
    expect(github.count("GET", "/repos/other/api/installation")).toBe(0)
  })

  it("reads an escaped key, a key file, and the FORGES_ names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-forge-"))
    try {
      const keyFile = join(dir, "app.pem")
      await writeFile(keyFile, github.privateKey)
      const escaped = { VITEHUB_GITHUB_APP_ID: github.appId, VITEHUB_GITHUB_PRIVATE_KEY: github.privateKey.replace(/\n/g, "\\n") }
      const fromFile = { VITEHUB_GITHUB_APP_ID: github.appId, VITEHUB_GITHUB_PRIVATE_KEY_PATH: keyFile }
      const fromForges = { FORGES_GITHUB_APP_ID: github.appId, FORGES_GITHUB_PRIVATE_KEY: await readFile(keyFile, "utf8") }

      for (const env of [escaped, fromFile, fromForges]) {
        await expect(useForge({ baseUrl: github.url, env }).token({ repository: "acme/web", refresh: true }))
          .resolves.toMatchObject([undefined, { token: expect.stringMatching(/^ghs_42_/) }])
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("gives a forges provider that calls the API with the installation token", async () => {
    const [error, provider] = await useForge({ baseUrl: github.url, env: appEnv() }).provider({ repository: "acme/web" })
    expect(error).toBeUndefined()

    const response = await provider!.request<{ full_name: string }>("GET", "/repos/acme/web")
    expect(response.data.full_name).toBe("acme/web")
    expect(github.requests.at(-1)?.authorization).toBe("Bearer ghs_42_1")
  })

  it("names the App and its bot user", async () => {
    await expect(useForge({ baseUrl: github.url, env: appEnv() }).app())
      .resolves.toEqual([undefined, { id: 123, slug: "acme-bot", login: "acme-bot[bot]" }])
  })

  it("returns FORGE_APP_NOT_INSTALLED when the App cannot reach the repository", async () => {
    const [error, token] = await useForge({ baseUrl: github.url, env: appEnv() }).token({ repository: "acme/private" })

    expect(token).toBeUndefined()
    expect(error).toMatchObject({
      code: "FORGE_APP_NOT_INSTALLED",
      why: "The GitHub App is not installed on acme/private.",
      docs: "https://vitehub.dev/docs/forge/diagnostics/forge_app_not_installed",
    })
  })

  it("returns FORGE_REQUEST_FAILED when GitHub rejects the token request", async () => {
    github.tokenStatus = 401
    const [error] = await useForge({ baseUrl: github.url, env: appEnv() }).token({ repository: "acme/web" })

    expect(error).toMatchObject({ code: "FORGE_REQUEST_FAILED", why: "POST /app/installations/42/access_tokens failed with HTTP 401." })
    expect(JSON.stringify(error)).not.toContain("BEGIN PRIVATE KEY")
  })

  it("returns FORGE_REQUEST_FAILED when the private key does not belong to the App", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const [error] = await useForge({ baseUrl: github.url, env: appEnv({ VITEHUB_GITHUB_PRIVATE_KEY: other }) }).app()

    expect(error).toMatchObject({ code: "FORGE_REQUEST_FAILED", why: "GET /app failed with HTTP 401." })
  })

  it("rejects with the abort reason", async () => {
    const reason = new Error("stop")
    await expect(useForge({ baseUrl: github.url, env: appEnv() }).token({ repository: "acme/web", signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason)
  })

  it("throws config errors", async () => {
    expect(() => useForge({ env: {} })).toThrow(expect.objectContaining({ code: "FORGE_MISSING_ENV" }))
    expect(() => useForge({ env: { VITEHUB_GITHUB_APP_ID: "123" } }))
      .toThrow(expect.objectContaining({ code: "FORGE_MISSING_ENV", why: "The github Forge has no credentials. It reads VITEHUB_GITHUB_PRIVATE_KEY or VITEHUB_GITHUB_PRIVATE_KEY_PATH." }))
    expect(() => useForge({ env: { VITEHUB_GITHUB_PRIVATE_KEY: github.privateKey } }))
      .toThrow(expect.objectContaining({ code: "FORGE_MISSING_ENV", why: "The github Forge has no credentials. It reads VITEHUB_GITHUB_APP_ID." }))
    expect(() => useForge({ env: appEnv({ VITEHUB_GITHUB_INSTALLATION_ID: "acme", VITEHUB_GITHUB_APP_OWNER: "acme" }) }))
      .toThrow(expect.objectContaining({ code: "FORGE_INVALID_ENV" }))
    expect(() => useForge({ env: appEnv({ VITEHUB_GITHUB_INSTALLATION_ID: "7" }) }))
      .toThrow(expect.objectContaining({ code: "FORGE_INVALID_ENV", why: expect.stringContaining("VITEHUB_GITHUB_INSTALLATION_ID needs VITEHUB_GITHUB_APP_OWNER") }))
    for (const value of ["[7]", "{\"acme\":0}", "not json"]) {
      expect(() => useForge({ env: appEnv({ VITEHUB_GITHUB_APP_INSTALLATIONS: value }) }))
        .toThrow(expect.objectContaining({ code: "FORGE_INVALID_ENV" }))
    }
    await expect(useForge({ baseUrl: github.url, env: appEnv() }).token())
      .rejects.toMatchObject({ code: "FORGE_MISSING_INSTALLATION" })
    await expect(useForge({ env: { VITEHUB_GITHUB_APP_ID: "1", VITEHUB_GITHUB_PRIVATE_KEY_PATH: "/missing/app.pem" } }).token({ repository: "acme/web" }))
      .rejects.toMatchObject({ code: "FORGE_INVALID_ENV" })
    expect(github.requests).toEqual([])
  })
})

describe("useForge() with a token", () => {
  it.each(["token", "provider"] as const)("%s rejects with the abort reason", async (method) => {
    const forge = useForge({ env: { VITEHUB_GITHUB_TOKEN: "ghp_token" } })
    const reason = new Error("stop")

    await expect(forge[method]({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  })

  it("provider rejects when cancelled while obtaining the token", async () => {
    const forge = useForge({ env: { VITEHUB_GITHUB_TOKEN: "ghp_token" } })
    const controller = new AbortController()
    const reason = new Error("stop")

    const provider = forge.provider({ signal: controller.signal })
    controller.abort(reason)

    await expect(provider).rejects.toBe(reason)
  })

  it("provider rejects when cancelled while loading the provider", async () => {
    const forge = useForge({ env: { VITEHUB_GITHUB_TOKEN: "ghp_token" } })
    const controller = new AbortController()
    const reason = new Error("stop")

    const provider = forge.provider({ signal: controller.signal })
    queueMicrotask(() => controller.abort(reason))

    await expect(provider).rejects.toBe(reason)
  })

  it("returns VITEHUB_GITHUB_TOKEN and throws FORGE_NOT_APP for app()", async () => {
    const forge = useForge({ env: { VITEHUB_GITHUB_TOKEN: " ghp_token " } })

    expect(forge.auth).toBe("token")
    await expect(forge.token()).resolves.toEqual([undefined, { token: "ghp_token", expiresAt: undefined }])
    await expect(forge.app()).rejects.toMatchObject({ code: "FORGE_NOT_APP" })
  })

  it("reads process.env by default", async () => {
    vi.stubEnv("VITEHUB_GITHUB_TOKEN", "ghp_from_process")
    await expect(useForge().token()).resolves.toEqual([undefined, { token: "ghp_from_process", expiresAt: undefined }])
  })

  it("reads the GitLab and Forgejo names", async () => {
    const gitlab = useForge({ forge: "gitlab", env: { VITEHUB_GITLAB_TOKEN: "glpat", VITEHUB_GITLAB_BASE_URL: "https://gitlab.example.test" } })
    expect(gitlab).toMatchObject({ kind: "gitlab", auth: "token", baseUrl: "https://gitlab.example.test" })
    await expect(gitlab.token()).resolves.toEqual([undefined, { token: "glpat", expiresAt: undefined }])

    expect(() => useForge({ forge: "forgejo", env: { VITEHUB_GITHUB_TOKEN: "ghp" } }))
      .toThrow(expect.objectContaining({ code: "FORGE_MISSING_ENV", why: "The forgejo Forge has no credentials. It reads VITEHUB_FORGEJO_TOKEN." }))
  })
})

it("documents each Forge error code with a heading", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/forge/limits-and-errors.md", import.meta.url), "utf8")
  const { forgeErrors } = await import("../src/errors.ts")
  for (const code of Object.keys(forgeErrors)) expect(page, code).toContain(`\n### ${code}\n`)
})
