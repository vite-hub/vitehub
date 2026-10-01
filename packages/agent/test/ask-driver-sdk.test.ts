import { afterEach, describe, expect, it, vi } from "vitest"

import { ask } from "../src/ask.ts"
import { askJev } from "../src/internal/ask-runtime.ts"

vi.mock("../src/internal/server-env.ts", () => ({
  importServerEnvModule: async () => ({ useServerEnv: () => ({ typesafe: { apiKey: "test-sdk-key", model: "jev-latest", provider: "typesafe" } }) }),
}))

afterEach(() => vi.unstubAllGlobals())

describe("Ask through the installed advocaat SDK", () => {
  it.each([0, 42, false, true, { toJSON: () => 0 }, { toJSON: () => false }])("converts scalar state %j to text for the SDK Entry contract", async (state) => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => Response.json({ answers: { accepted: { type: "noul", noul: 0.75 } } }))
    vi.stubGlobal("fetch", fetch)
    await expect(askJev({}, state, { accepted: ask.if("Accept it?", { threshold: 0.5 }) })).resolves.toEqual({ accepted: true })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ state: String(JSON.parse(JSON.stringify(state))), questions: { accepted: { type: "noul", instructions: "Accept it?" } }, model: "jev-latest" })
  })

  it("normalizes scalar entries while preserving nested JSON, answers, and original score legends", async () => {
    const nested = { amount: 42, enabled: false, values: [0, true] }
    const answers = {
      chance: { type: "noul", noul: 0.25 },
      choice: { type: "choice", choice: "yes", confidence: 0.8, probabilities: { no: 0.1, yes: 0.9 } },
      switch: { type: "choice", choice: "yes", confidence: 0.8, probabilities: { no: 0.1, yes: 0.9 } },
      score: { type: "score", score: 1, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.9, 2: 0 }, legend: { 0: "0", 1: "false", 2: nested } },
    }
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) => Response.json({ answers }))
    vi.stubGlobal("fetch", fetch)
    const criteria = [0, false, nested] as const
    const result = await askJev({}, nested, {
      chance: ask.chance(false, { true: 0, false: false }),
      choice: ask.choice(0, { no: false, yes: nested }),
      switch: ask.switch(true, { no: 0, yes: true }),
      score: ask.score(false, criteria),
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      state: nested,
      questions: {
        chance: { criteria: { true: "0", false: "false" }, instructions: "false", type: "noul" },
        choice: { criteria: { no: "false", yes: nested }, instructions: "0", type: "choice" },
        switch: { type: "choice", instructions: "true", criteria: { no: "0", yes: "true" } },
        score: { criteria: ["0", "false", nested], instructions: "false", type: "score" },
      },
      model: "jev-latest",
    })
    expect(result).toEqual({
      chance: { type: "chance", chance: 0.25 },
      choice: answers.choice,
      switch: "yes",
      score: { ...answers.score, legend: { 0: 0, 1: false, 2: nested }, ratio: 0.5 },
    })
    expect(criteria).toEqual([0, false, nested])
  })
})
