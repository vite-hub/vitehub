import { generateKeyPairSync } from "node:crypto"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { createGitHubWorkspaceStore } from "../src/providers/github/store.ts"
import { createFakeGitHub } from "./fake-github.ts"

import type { FakeGitHub } from "./fake-github.ts"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
let fake: FakeGitHub
let minted = 0

beforeEach(() => {
  minted = 0
  fake = createFakeGitHub()
  fake.respond((request) => {
    if (request.method === "POST" && request.path === "/app/installations/176/access_tokens") {
      minted++
      return Response.json({ token: `ghs_installation_${minted}`, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, { status: 201 })
    }
    if (request.path === "/repos/onmax/repo/installation") return Response.json({ id: 176 })
    return undefined
  })
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "personal-token")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
  vi.stubEnv("VITEHUB_GITHUB_APP_ID", "1234")
  vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY", privateKey.replace(/\n/g, "\\n"))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function store(options: { token?: string } = {}) {
  return createGitHubWorkspaceStore({ provider: "github", repository: "onmax/repo", root: "", ...options }, "docs")
}

it("reads the repository as the GitHub App installation when VITEHUB_GITHUB_APP_ID is set", async () => {
  vi.stubEnv("VITEHUB_GITHUB_INSTALLATION_ID", "176")
  fake.commit("main", { "docs/a.md": "A\n" })
  const docs = store()
  expect(new TextDecoder().decode((await docs.readFile("docs/a.md"))!.content as Uint8Array)).toBe("A\n")
  await docs.history!.list({ ref: "main" })
  const repositoryReads = fake.requests.filter(request => request.path.startsWith("/repos/onmax/repo/"))
  expect(repositoryReads.length).toBeGreaterThan(1)
  expect(repositoryReads.every(request => /^(?:token|Bearer) ghs_installation_1$/.test(request.headers.get("authorization") ?? ""))).toBe(true)
  // One installation token serves every request until it nearly expires.
  expect(minted).toBe(1)
  expect(fake.requests.some(request => request.path === "/repos/onmax/repo/installation")).toBe(false)
})

it("finds the installation of the repository without VITEHUB_GITHUB_INSTALLATION_ID", async () => {
  // Installation tokens are cached per App, so this test uses another one.
  vi.stubEnv("VITEHUB_GITHUB_APP_ID", "5678")
  fake.commit("main", { "docs/a.md": "A\n" })
  await store().readFile("docs/a.md")
  const lookup = fake.requests.find(request => request.path === "/repos/onmax/repo/installation")
  expect(lookup?.headers.get("authorization")).toMatch(/^Bearer ey/)
  expect(minted).toBe(1)
})

it("keeps the token option ahead of the GitHub App", async () => {
  fake.commit("main", { "docs/a.md": "A\n" })
  await store({ token: "option-token" }).readFile("docs/a.md")
  expect(minted).toBe(0)
  expect(fake.requests.every(request => request.headers.get("authorization")?.endsWith("option-token"))).toBe(true)
})

it("names the App setting that is missing", async () => {
  vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY", "")
  await expect(store().readFile("docs/a.md")).rejects.toMatchObject({ message: expect.stringContaining("VITEHUB_GITHUB_PRIVATE_KEY") })
})
