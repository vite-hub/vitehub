import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeRegistry } from "../../env/src/core/resolve.ts"
import { typesafeEnv } from "../../env/src/presets.ts"
import { resolveServerEnv } from "../../env/src/server.ts"
import { ask } from "../src/ask.ts"
import { jev } from "../src/gateways.ts"

const fake = vi.hoisted(() => ({ serverEnv: {} as Record<string, unknown> }))

vi.mock("../src/internal/server-env.ts", () => ({
  importServerEnvModule: async () => ({ useServerEnv: () => fake.serverEnv }),
}))

afterEach(() => {
  fake.serverEnv = {}
  vi.unstubAllEnvs()
})

const questions = {
  category: ask.choice("Which category fits?", { groceries: "Food shops.", rent: "Housing." }),
  fits: ask.chance("Does any category fit?"),
}

/** The TypeSafe API answer, as the TypeSafe API and Cloudflare AI Gateway return it. */
const typesafeAnswer = () => Response.json({
  answers: {
    category: { type: "choice", choice: "groceries", confidence: 0.9, probabilities: { groceries: 0.95, rent: 0.05 } },
    fits: { type: "noul", noul: 0.8 },
  },
  model: "jev-1.14",
  usage: { input_tokens: 40, output_tokens: 0 },
})

/** The Vercel AI Gateway answer, which advocaat maps back to the TypeSafe shape. */
const vercelAnswer = () => Response.json({
  answers: {
    category: { type: "choice", choice: "groceries", confidence: 0.9, probabilities: { groceries: 0.95, rent: 0.05 } },
    fits: { type: "boolean", probability: 0.8 },
  },
})

const expected = {
  category: { type: "choice", choice: "groceries", confidence: 0.9, probabilities: { groceries: 0.95, rent: 0.05 } },
  fits: { type: "chance", chance: 0.8 },
}

function request(fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>) {
  const [url, init] = fetch.mock.calls[0] ?? []
  return { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers), url: String(url) }
}

function resolveTypesafe(options: Parameters<typeof typesafeEnv>[0], env: Record<string, string>) {
  return resolveServerEnv(createRuntimeRegistry({ typesafe: typesafeEnv(options) }), { env })
}

describe("jev()", () => {
  it("calls the TypeSafe API with a TypeSafe key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await expect(jev({ apiKey: "ts-key", fetch, provider: "typesafe" }).ask("Mercadona 23.10", questions)).resolves.toEqual(expected)

    const sent = request(fetch)
    expect(sent.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(sent.headers.get("authorization")).toBe("Bearer ts-key")
    expect(sent.headers.has("cf-aig-authorization")).toBe(false)
    expect(sent.body).toEqual({
      model: "jev-latest",
      questions: {
        category: { criteria: { groceries: "Food shops.", rent: "Housing." }, instructions: "Which category fits?", type: "choice" },
        fits: { instructions: "Does any category fit?", type: "noul" },
      },
      state: "Mercadona 23.10",
    })
  })

  it("reports the model and token usage of each request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    const onUsage = vi.fn()
    await jev({ apiKey: "ts-key", fetch, provider: "typesafe" }).ask("state", questions, { onUsage })

    expect(onUsage).toHaveBeenCalledWith({ model: "jev-1.14", provider: "typesafe", usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 } })
  })

  it("calls Vercel AI Gateway with an AI Gateway key and the gateway model", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => vercelAnswer())
    await expect(jev({ apiKey: "gateway-key", fetch, provider: "vercel" }).ask("Mercadona 23.10", questions)).resolves.toEqual(expected)

    const sent = request(fetch)
    expect(sent.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    expect(sent.headers.get("authorization")).toBe("Bearer gateway-key")
    expect(sent.headers.get("ai-model-id")).toBe("typesafe-ai/jev")
    expect(sent.body).toMatchObject({ questions: { fits: { type: "boolean" } }, state: "Mercadona 23.10" })
  })

  it("calls TypeSafe through a Cloudflare AI Gateway custom provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    const client = jev({
      apiKey: "ts-key",
      cloudflare: { accountId: "account", gatewayId: "finance", token: "cf-token" },
      fetch,
      model: "jev-1.14",
      provider: "cloudflare",
    })
    await expect(client.ask("Mercadona 23.10", questions)).resolves.toEqual(expected)

    const sent = request(fetch)
    expect(sent.url).toBe("https://gateway.ai.cloudflare.com/v1/account/finance/custom-typesafe/v1/systemone")
    expect(sent.headers.get("authorization")).toBe("Bearer ts-key")
    expect(sent.headers.get("cf-aig-authorization")).toBe("Bearer cf-token")
    expect(sent.body).toMatchObject({ model: "jev-1.14", state: "Mercadona 23.10" })
  })

  it("uses the custom provider slug and leaves out the gateway token of an open gateway", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await jev({ apiKey: "ts-key", cloudflare: { accountId: "account", gatewayId: "finance", slug: "jev" }, fetch, provider: "cloudflare" }).ask("state", questions)

    const sent = request(fetch)
    expect(sent.url).toBe("https://gateway.ai.cloudflare.com/v1/account/finance/custom-jev/v1/systemone")
    expect(sent.headers.has("cf-aig-authorization")).toBe(false)
  })

  it("never reads the Server Env with explicit credentials", async () => {
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "jev-from-env")
    fake.serverEnv = { typesafe: { apiKey: "env-key", model: "jev-env", provider: "typesafe" } }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await jev({ apiKey: "tenant-key", fetch, provider: "typesafe" }).ask("state", questions)

    const sent = request(fetch)
    expect(sent.headers.get("authorization")).toBe("Bearer tenant-key")
    expect(sent.body.model).toBe("jev-latest")
  })

  it("diagnoses missing explicit credentials before any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await expect(jev({ apiKey: " ", fetch, provider: "typesafe" }).ask("state", questions)).rejects.toMatchObject({
      code: "AGENT_R0936",
      message: expect.stringContaining("jev({ provider: \"typesafe\" }) requires apiKey"),
    })
    await expect(jev({ apiKey: "ts-key", cloudflare: { accountId: "", gatewayId: "" }, fetch, provider: "cloudflare" }).ask("state", questions)).rejects.toMatchObject({
      code: "AGENT_R0936",
      message: expect.stringContaining("cloudflare.accountId and cloudflare.gatewayId"),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("names jev() options when the provider rejects an explicit key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: "unauthorized" }, { status: 401 }))
    const error = await jev({ apiKey: "ts-key", cloudflare: { accountId: "account", gatewayId: "finance" }, fetch, provider: "cloudflare" })
      .ask("state", questions)
      .catch((error: unknown) => error)

    expect(fetch).toHaveBeenCalledOnce()
    expect(error).toMatchObject({ code: "AGENT_R1009", providerStatus: 401, status: 503 })
    expect(String((error as Error).message)).toContain("Cloudflare AI Gateway Jev provider rejected the API key with HTTP 401")
    expect((error as { fix?: string }).fix).toContain("jev()")
  })
})

describe("jev() with typesafeEnv()", () => {
  it("reads the TypeSafe provider from the Server Env", async () => {
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", undefined)
    fake.serverEnv = resolveTypesafe(undefined, { TYPESAFE_API_KEY: "env-key" })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await expect(jev({ fetch }).ask("state", questions)).resolves.toEqual(expected)

    const sent = request(fetch)
    expect(sent.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(sent.headers.get("authorization")).toBe("Bearer env-key")
    expect(sent.body.model).toBe("jev-latest")
  })

  it("reads the Vercel provider from the Server Env", async () => {
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", undefined)
    fake.serverEnv = resolveTypesafe({ provider: "vercel" }, { AI_GATEWAY_API_KEY: "gateway-key" })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => vercelAnswer())
    await jev({ fetch }).ask("state", questions)

    const sent = request(fetch)
    expect(sent.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    expect(sent.headers.get("authorization")).toBe("Bearer gateway-key")
    expect(sent.headers.get("ai-model-id")).toBe("typesafe-ai/jev")
  })

  it("reads the Cloudflare gateway from the Server Env", async () => {
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", undefined)
    fake.serverEnv = resolveTypesafe({ provider: "cloudflare" }, {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_AI_GATEWAY_ID: "finance",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "cf-token",
      TYPESAFE_API_KEY: "env-key",
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await jev({ fetch }).ask("state", questions)

    const sent = request(fetch)
    expect(sent.url).toBe("https://gateway.ai.cloudflare.com/v1/account/finance/custom-typesafe/v1/systemone")
    expect(sent.headers.get("authorization")).toBe("Bearer env-key")
    expect(sent.headers.get("cf-aig-authorization")).toBe("Bearer cf-token")
    expect(sent.body.model).toBe("jev-latest")
  })

  it("names the missing Cloudflare variables", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", undefined)
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined)
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", undefined)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    fake.serverEnv = resolveTypesafe({ provider: "cloudflare" }, {})
    await expect(jev({ fetch }).ask("state", questions)).rejects.toMatchObject({ code: "AGENT_R0936", message: expect.stringContaining("TYPESAFE_API_KEY") })

    fake.serverEnv = resolveTypesafe({ provider: "cloudflare" }, { CLOUDFLARE_ACCOUNT_ID: "account", TYPESAFE_API_KEY: "env-key" })
    await expect(jev({ fetch }).ask("state", questions)).rejects.toMatchObject({
      code: "AGENT_R0936",
      message: expect.stringContaining("require CLOUDFLARE_AI_GATEWAY_ID"),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("names the Server Env variables when the gateway rejects them", async () => {
    fake.serverEnv = resolveTypesafe({ provider: "cloudflare" }, { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_AI_GATEWAY_ID: "finance", TYPESAFE_API_KEY: "env-key" })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: "unauthorized" }, { status: 401 }))
    const error = await jev({ fetch }).ask("state", questions).catch((error: unknown) => error)

    expect((error as { fix?: string }).fix).toContain("TYPESAFE_API_KEY or CLOUDFLARE_AI_GATEWAY_TOKEN")
  })
})
