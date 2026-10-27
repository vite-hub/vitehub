import { afterEach, describe, expect, it, vi } from "vitest"

import { ask } from "../src/ask.ts"
import { cliproxy, cloudflare, defineAiGateway, typesafe, vercel } from "../src/gateways.ts"

afterEach(() => {
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

describe("gateway.ask()", () => {
  it("asks the TypeSafe API with a TypeSafe key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await expect(typesafe({ apiKey: "ts-key", fetch }).ask("Mercadona 23.10", questions)).resolves.toEqual(expected)

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
    await typesafe({ apiKey: "ts-key", fetch }).ask("state", questions, { onUsage })

    expect(onUsage).toHaveBeenCalledWith({ model: "jev-1.14", provider: "typesafe", usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 } })
  })

  it("asks Vercel AI Gateway with an AI Gateway key and the gateway model", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => vercelAnswer())
    await expect(vercel({ apiKey: "gateway-key", fetch }).ask("Mercadona 23.10", questions)).resolves.toEqual(expected)

    const sent = request(fetch)
    expect(sent.url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
    expect(sent.headers.get("authorization")).toBe("Bearer gateway-key")
    expect(sent.headers.get("ai-model-id")).toBe("typesafe-ai/jev")
    expect(sent.body).toMatchObject({ questions: { fits: { type: "boolean" } }, state: "Mercadona 23.10" })
  })

  it("asks TypeSafe through a Cloudflare AI Gateway custom provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    const gateway = cloudflare({ accountId: "account", apiKey: "ts-key", fetch, gatewayId: "finance", model: "jev-1.14", token: "cf-token" })
    await expect(gateway.ask("Mercadona 23.10", questions)).resolves.toEqual(expected)

    const sent = request(fetch)
    expect(sent.url).toBe("https://gateway.ai.cloudflare.com/v1/account/finance/custom-typesafe/v1/systemone")
    expect(sent.headers.get("authorization")).toBe("Bearer ts-key")
    expect(sent.headers.get("cf-aig-authorization")).toBe("Bearer cf-token")
    expect(sent.body).toMatchObject({ model: "jev-1.14", state: "Mercadona 23.10" })
  })

  it("uses the custom provider slug and leaves out the token of an open gateway", async () => {
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_TOKEN", undefined)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await cloudflare({ accountId: "account", apiKey: "ts-key", fetch, gatewayId: "finance", slug: "jev" }).ask("state", questions)

    const sent = request(fetch)
    expect(sent.url).toBe("https://gateway.ai.cloudflare.com/v1/account/finance/custom-jev/v1/systemone")
    expect(sent.headers.has("cf-aig-authorization")).toBe(false)
  })

  it("reads each preset's credentials from the host Env", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "env-ts-key")
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "env-account")
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", "env-gateway")
    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_TOKEN", "env-token")
    vi.stubEnv("AI_GATEWAY_API_KEY", "env-gateway-key")
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await typesafe({ fetch }).ask("state", questions)
    await cloudflare({ fetch }).ask("state", questions)
    const vercelFetch = vi.fn<typeof globalThis.fetch>(async () => vercelAnswer())
    await vercel({ fetch: vercelFetch }).ask("state", questions)

    expect(fetch.mock.calls.map(([url, init]) => [String(url), new Headers(init?.headers).get("authorization"), new Headers(init?.headers).get("cf-aig-authorization")])).toEqual([
      ["https://api.typesafe.ai/v1/systemone", "Bearer env-ts-key", null],
      ["https://gateway.ai.cloudflare.com/v1/env-account/env-gateway/custom-typesafe/v1/systemone", "Bearer env-ts-key", "Bearer env-token"],
    ])
    expect(new Headers(vercelFetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer env-gateway-key")
  })

  it("names the missing variables before any request", async () => {
    for (const name of ["TYPESAFE_API_KEY", "VITEHUB_TYPESAFE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_GATEWAY_ID"]) vi.stubEnv(name, undefined)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => typesafeAnswer())
    await expect(typesafe({ fetch }).ask("state", questions)).rejects.toMatchObject({ code: "AGENT_R0977", message: expect.stringContaining("Set TYPESAFE_API_KEY, or pass apiKey") })
    await expect(cloudflare({ apiKey: "ts-key", fetch, gatewayId: "finance" }).ask("state", questions)).rejects.toMatchObject({
      code: "AGENT_R0980",
      message: expect.stringContaining("Set CLOUDFLARE_ACCOUNT_ID, or pass accountId"),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("names the key to rotate when the provider rejects it", async () => {
    const rejected = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: "unauthorized" }, { status: 401 }))
    const explicit = await cloudflare({ accountId: "account", apiKey: "ts-key", fetch: rejected, gatewayId: "finance" }).ask("state", questions).catch((error: unknown) => error)
    expect(rejected).toHaveBeenCalledOnce()
    expect(explicit).toMatchObject({ code: "AGENT_R1009", providerStatus: 401, status: 503 })
    expect(String((explicit as Error).message)).toContain("Cloudflare AI Gateway Jev provider rejected the API key with HTTP 401")
    expect((explicit as { fix?: string }).fix).toContain("Pass a valid apiKey to the gateway")

    vi.stubEnv("TYPESAFE_API_KEY", "env-ts-key")
    const fromEnv = await typesafe({ fetch: rejected }).ask("state", questions).catch((error: unknown) => error)
    expect((fromEnv as { fix?: string }).fix).toContain("Set or rotate TYPESAFE_API_KEY")
  })

  it("fails with a diagnostic when a Driver-only gateway is asked anyway", async () => {
    const gateways = [cliproxy({ apiKey: "k", url: "https://proxy.example" }), defineAiGateway({ apiKey: "k", baseURL: { codex: "https://proxy.example/v1" }, name: "internal" })]
    for (const gateway of gateways) {
      // SAFETY: The types reject ask() on these gateways; the call checks the runtime diagnostic.
      await expect((gateway as unknown as { ask: typeof typesafe extends () => infer G ? G extends { ask: infer A } ? A : never : never }).ask("state", questions)).rejects.toMatchObject({
        code: "AGENT_R1013",
        message: expect.stringContaining(`Gateway "${gateway.name}" routes Driver model requests and cannot answer Jev questions`),
      })
    }
  })

  it("keeps ask() out of copies and Driver routes", () => {
    expect({ ...typesafe({ apiKey: "k" }) }).toEqual({ apiKey: "k", baseURL: {}, name: "typesafe" })
    expect(Object.keys(vercel({ apiKey: "k" }))).toEqual(["name", "baseURL", "apiKey"])
  })
})
