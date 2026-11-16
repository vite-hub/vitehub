import { generateKeyPairSync } from "node:crypto"
import { expect, it, vi } from "vitest"

import { activeProviderSandbox, agentSettings, defineAgent, withoutForgeAccess } from "../src/index.ts"
import { github } from "../src/channels.ts"
import { readForgeAccess } from "../src/internal/forge-access.ts"
import { setActiveProviderSandbox } from "../src/internal/provider-box.ts"
import type { AgentCallbackContext, AgentInvocationContextStore } from "../src/types.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

it("agentSettings() returns a copy of the resolved settings with extends applied", () => {
  const decoration = Symbol("decoration")
  const parent = defineAgent({ driver: { model: "parent" }, description: "parent" })
  const child = defineAgent({ extends: parent, driver: { model: "child" } })
  Object.defineProperty(child, decoration, { enumerable: true, value: "kept" })

  const settings = agentSettings(child)
  expect(settings).toMatchObject({ description: "parent", driver: { model: "child" } })
  expect(settings && Object.getOwnPropertyDescriptor(settings, decoration)?.value).toBe("kept")

  settings!.description = "changed"
  settings!.driver = { model: "worker" }
  expect(agentSettings(child)).toMatchObject({ description: "parent", driver: { model: "child" } })
  expect(agentSettings({} as typeof child)).toBeUndefined()
})

it("withoutForgeAccess() removes the host GitHub access and keeps the rest of the Channel", () => {
  const channel = github({ app: { token: "host-token" } })
  expect(readForgeAccess(channel)).toBeTypeOf("function")

  const copy = withoutForgeAccess(channel)
  expect(readForgeAccess(copy)).toBeUndefined()
  expect(copy.kind).toBe("github")
  expect(readForgeAccess(channel)).toBeTypeOf("function")
})

it("activeProviderSandbox() reads the Sandbox of the current Invocation only", () => {
  const context = {} as AgentInvocationContextStore
  expect(activeProviderSandbox(context)).toBeUndefined()
  const session = { home: "/home/agent" } as Parameters<typeof setActiveProviderSandbox>[1]
  const clear = setActiveProviderSandbox(context, session)
  expect(activeProviderSandbox(context)).toBe(session)
  expect(activeProviderSandbox({} as AgentInvocationContextStore)).toBeUndefined()
  clear()
  expect(activeProviderSandbox(context)).toBeUndefined()
})

it("github() routes the Server Env installation of each repository owner", async () => {
  vi.stubEnv("VITEHUB_GITHUB_INSTALLATION_ID", "7")
  vi.stubEnv("VITEHUB_GITHUB_APP_OWNER", "acme")
  vi.stubEnv("VITEHUB_GITHUB_APP_INSTALLATIONS", "{\"Other\":9}")
  try {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    const lookups: string[] = []
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      if (url.pathname.endsWith("/installation")) {
        lookups.push(url.pathname)
        return Response.json({ id: 11 })
      }
      const minted = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/)
      if (minted) return Response.json({ token: `token-${minted[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      throw new Error(`Unexpected GitHub API call: ${url}`)
    }
    // SAFETY: the fixture supplies a Fetch-compatible function.
    const channel = github({ app: { apiBaseUrl: "https://api.github.test", appId: "routing-app", privateKey, fetch: fetcher as typeof fetch } })
    const access = readForgeAccess(channel)!
    const token = async (repository: string) => (await access({} as AgentCallbackContext, { repository }))?.token

    expect(await token("acme/web")).toBe("token-7")
    expect(await token("other/api")).toBe("token-9")
    expect(await token("third/app")).toBe("token-11")
    expect(lookups).toEqual(["/repos/third/app/installation"])
  }
  finally {
    vi.unstubAllEnvs()
  }
})
