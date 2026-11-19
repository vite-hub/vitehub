import { MockLanguageModelV3 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"

import { typesafe } from "@vite-hub/gateways"
import { defineChoices, toOptions } from "../src/index.ts"
import { wordGateway } from "./support.ts"

const suppliers = toOptions([{ code: "S1", name: "Vak Supply" }, { code: "S2", name: "Nord Parts" }, { code: "S3", name: "Vakuum Co" }], {
  label: item => item.name,
  value: item => item.code,
})

function forecast(calls: Parameters<typeof wordGateway>[0] = []) {
  return defineChoices({
    gateway: wordGateway(calls),
    groups: {
      chart: { label: "Chart", multiple: false, options: [{ label: "Line", value: "line" }, { label: "Bar", value: "bar" }] },
      supplier: { label: "Supplier", options: suppliers },
    },
    name: "forecast",
  })
}

describe("defineChoices().resolve()", () => {
  it("includes and excludes options of a multiple group", async () => {
    const [error, selection] = await forecast().resolve("nord parts except vak supply")
    expect(error).toBeUndefined()
    expect(selection?.supplier).toEqual({ exclude: ["S1"], include: ["S2"] })
  })

  it("picks one option of a single group and ranks every option", async () => {
    const [error, selection] = await forecast().resolve("show bar for nord parts")
    expect(error).toBeUndefined()
    expect(selection?.chart.value).toBe("bar")
    expect(selection?.chart.ranked.map(item => item.value)[0]).toBe("bar")
    expect(selection?.chart.ranked).toHaveLength(2)
    expect(selection?.supplier.include).toEqual(["S2"])
  })

  it("returns an empty selection when the text names nothing but is supported", async () => {
    const [error, selection] = await forecast().resolve("something else")
    expect(error).toBeUndefined()
    expect(selection).toMatchObject({ chart: { value: null }, supplier: { exclude: [], include: [] } })
  })

  it("returns DECISIONS_R0004 when the model says the options cannot express the text", async () => {
    const [error, selection] = await forecast().resolve("unsupported request")
    expect(error?.code).toBe("DECISIONS_R0004")
    expect(selection).toBeUndefined()
  })

  it("keeps an option below the threshold out of the selection", async () => {
    const choices = defineChoices({
      gateway: wordGateway(),
      groups: { supplier: { label: "Supplier", options: suppliers } },
      thresholds: { option: 0.95 },
    })
    const [, selection] = await choices.resolve("nord parts")
    expect(selection?.supplier.include).toEqual([])
  })

  it("passes context to option functions and the signal to the gateway", async () => {
    const calls: Parameters<typeof wordGateway>[0] = []
    const seen: unknown[] = []
    const options = async (context: { tenant: string }) => {
      seen.push(context)
      return [{ label: `${context.tenant} Mill`, value: context.tenant }]
    }
    const choices = defineChoices({ gateway: wordGateway(calls), groups: { site: { label: "Site", options } } })
    const controller = new AbortController()
    const [error, selection] = await choices.resolve("acme mill", { context: { tenant: "acme" }, signal: controller.signal })
    expect(error).toBeUndefined()
    expect(seen).toEqual([{ tenant: "acme" }])
    expect(selection?.site.include).toEqual(["acme"])
    expect(calls[0]?.signal).toBe(controller.signal)
  })

  it("sends one question per option of a multiple group, one per single group, and the supported check", async () => {
    const calls: Parameters<typeof wordGateway>[0] = []
    await forecast(calls).resolve("bar")
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(["g0", "g1_o0", "g1_o1", "g1_o2", "supported"])
  })

  it("adds top-level hints to every question, including the supported check", async () => {
    const calls: Parameters<typeof wordGateway>[0] = []
    const hints = "mtop means Make to order"
    const choices = defineChoices({
      gateway: wordGateway(calls),
      groups: {
        chart: { label: "Chart", multiple: false, options: [{ label: "Bar", value: "bar" }] },
        strategy: { label: "Strategy", options: [{ label: "Make to order", value: "mto" }] },
      },
      hints,
    })
    const [error, plan] = await choices.inspect("mtop")
    expect(error).toBeUndefined()
    expect(plan?.questions).toMatchObject({
      g0: { instructions: expect.stringContaining(hints) },
      g1_o0: { instructions: expect.stringContaining(hints) },
      supported: { instructions: expect.stringContaining(hints) },
    })
    await choices.resolve("mtop")
    expect(calls[0]?.questions).toEqual(plan?.questions)
  })
})

describe("defineChoices() with a model", () => {
  it("asks an AI SDK model instead of a gateway", async () => {
    const prompts: unknown[] = []
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(options.prompt)
        return {
          content: [{ text: JSON.stringify({ g0: { choice: "Console", confidence: 0.9 } }), type: "text" }],
          finishReason: { raw: "stop", unified: "stop" },
          usage: { inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 }, outputTokens: { reasoning: 0, text: 1, total: 1 } },
          warnings: [],
        }
      },
    })
    const inbox = defineChoices({
      groups: {
        project: {
          infer: true,
          label: "Project",
          multiple: false,
          options: [
            { description: "The docs site.", label: "Docs", value: "docs" },
            { description: "Runs, queues, and logs.", label: "Console", value: "console" },
          ],
        },
      },
      model,
    })

    const [error, selection] = await inbox.resolve("the queue tab crashes")
    expect(error).toBeUndefined()
    expect(selection?.project).toMatchObject({ confidence: expect.closeTo(0.8, 5), value: "console" })
    expect(JSON.stringify(prompts[0])).toContain("Console: Runs, queues, and logs.")
  })

  it("needs exactly one of gateway or model", () => {
    const groups = { chart: { label: "Chart", multiple: false, options: [{ label: "Line", value: "line" }] } }
    expect(() => defineChoices({ groups })).toThrow(/one of gateway or model/)
    expect(() => defineChoices({ gateway: wordGateway(), groups, model: new MockLanguageModelV3() })).toThrow(/one of gateway or model/)
  })
})

describe("defineChoices() with infer", () => {
  const projects = [
    { description: "General tasks: translate, explain, research, write.", label: "No project", value: "scratch" },
    { description: "Server primitives, the Console, and the docs site.", label: "ViteHub", value: "vitehub" },
    { description: "Thai lessons and flash card decks.", label: "Thai", value: "thai" },
  ]

  function router(calls: Parameters<typeof wordGateway>[0] = []) {
    return defineChoices({
      gateway: wordGateway(calls),
      groups: { project: { infer: true, label: "Project", multiple: false, options: projects } },
      limits: { text: 2000 },
    })
  }

  it("chooses an option that the text does not name, from its description", async () => {
    const [error, selection] = await router().resolve("the console crashes when I open the queue tab")
    expect(error).toBeUndefined()
    expect(selection?.project.value).toBe("vitehub")
    expect(selection?.project.ranked).toHaveLength(3)
  })

  it("asks no supported check and offers no none answer", async () => {
    const calls: Parameters<typeof wordGateway>[0] = []
    await router(calls).resolve("translate this")
    expect(Object.keys(calls[0]!.questions)).toEqual(["g0"])
    expect(calls[0]!.questions.g0).toMatchObject({
      criteria: { "No project": projects[0]!.description, "Thai": projects[2]!.description, "ViteHub": projects[1]!.description },
      instructions: expect.stringContaining("does not have to name the option"),
    })
    // The description is sent once, in the criteria.
    expect(JSON.stringify(calls[0]!.state)).not.toContain(projects[0]!.description)
    expect(calls[0]!.state).toMatchObject({ groups: [{ infer: true, options: [{ label: "No project", value: "scratch" }, {}, {}] }] })
  })

  it("keeps a weak guess out of value but ranks it", async () => {
    const [, selection] = await router().resolve("hello")
    expect(selection?.project.value).toBeNull()
    expect(selection?.project.ranked[0]).toEqual({ probability: 0.4, value: "scratch" })
  })

  it("answers a group with one option without the gateway", async () => {
    const calls: Parameters<typeof wordGateway>[0] = []
    const one = defineChoices({ gateway: wordGateway(calls), groups: { project: { infer: true, label: "Project", multiple: false, options: [projects[1]!] } } })
    const [error, selection] = await one.resolve("anything")
    expect(error).toBeUndefined()
    expect(selection?.project).toEqual({ confidence: 1, ranked: [{ probability: 1, value: "vitehub" }], value: "vitehub" })
    expect(calls).toHaveLength(0)
  })

  it("still checks the groups that do not infer", async () => {
    const calls: Parameters<typeof wordGateway>[0] = []
    const mixed = defineChoices({
      gateway: wordGateway(calls),
      groups: {
        project: { infer: true, label: "Project", multiple: false, options: projects },
        supplier: { label: "Supplier", options: suppliers },
      },
    })
    expect((await mixed.resolve("unsupported thai"))[0]?.code).toBe("DECISIONS_R0004")
    const supported = JSON.stringify(calls[0]!.questions.supported)
    expect(supported).toContain("Judge only the \\\"Supplier\\\" group. Ignore every group with infer: true.")
    expect(supported).toContain("Also true when the text sets no constraint for these groups.")
    expect(supported).not.toContain("names no option at all")
  })

  it("needs multiple: false", () => {
    expect(() => defineChoices({ gateway: wordGateway(), groups: { a: { infer: true, label: "A", options: [] } } })).toThrow(/multiple: false/)
  })
})

describe("defineChoices() errors", () => {
  it("returns DECISIONS_R0003 for empty and too long text, and asks nothing", async () => {
    const calls: Parameters<typeof wordGateway>[0] = []
    const choices = forecast(calls)
    expect((await choices.resolve("   "))[0]?.code).toBe("DECISIONS_R0003")
    expect((await choices.resolve("x".repeat(301)))[0]?.code).toBe("DECISIONS_R0003")
    expect(calls).toHaveLength(0)
  })

  it("returns DECISIONS_R0002 over the limits and for duplicate values", async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ label: `Option ${index}`, value: index }))
    const big = defineChoices({ gateway: wordGateway(), groups: { all: { label: "All", options: many } } })
    expect((await big.resolve("option 1"))[0]?.code).toBe("DECISIONS_R0002")
    const twice = defineChoices({ gateway: wordGateway(), groups: { all: { label: "All", options: [{ label: "A", value: 1 }, { label: "B", value: 1 }] } } })
    expect((await twice.resolve("a"))[0]?.message).toContain("twice")
    const clash = defineChoices({ gateway: wordGateway(), groups: { all: { label: "All", multiple: false, options: [{ label: "A", value: 1 }, { label: "A", value: 2 }] } } })
    expect((await clash.resolve("a"))[0]?.message).toContain("unique")
  })

  it("returns DECISIONS_R0002 when an options function throws", async () => {
    const choices = defineChoices({ gateway: wordGateway(), groups: { all: { label: "All", options: async () => { throw new Error("db down") } } } })
    const [error] = await choices.resolve("a")
    expect(error?.code).toBe("DECISIONS_R0002")
    expect(error?.cause).toBeInstanceOf(Error)
  })

  it("returns DECISIONS_R0005 when the gateway throws and DECISIONS_R0006 for a missing answer", async () => {
    const throwing = defineChoices({ gateway: { ask: async () => { throw new Error("offline") } }, groups: { s: { label: "S", options: suppliers } } })
    expect((await throwing.resolve("nord"))[0]?.code).toBe("DECISIONS_R0005")
    const partial = defineChoices({ gateway: { ask: async () => ({ supported: { chance: 0.9, type: "chance" } }) as never }, groups: { s: { label: "S", options: suppliers } } })
    expect((await partial.resolve("nord"))[0]?.code).toBe("DECISIONS_R0006")
  })

  describe("gateway failures", () => {
    afterEach(() => {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    })

    it("puts a missing API key in the message", async () => {
      vi.stubEnv("TYPESAFE_API_KEY", "")
      const choices = defineChoices({ gateway: typesafe(), groups: { s: { label: "S", options: suppliers } } })
      const [error] = await choices.resolve("nord")
      expect(error?.code).toBe("DECISIONS_R0005")
      expect(error?.message).toMatch(/^\[vitehub\] The gateway request failed: Gateway "typesafe" needs an API key\. Set TYPESAFE_API_KEY/)
      expect(error?.cause).toMatchObject({ code: "GATEWAYS_R0002" })
    })

    it("uses the gateway fix for a rejected key", async () => {
      vi.stubEnv("TYPESAFE_API_KEY", "fake-key")
      vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { message: "invalid key" } }, { status: 401 })))
      const choices = defineChoices({ gateway: typesafe(), groups: { s: { label: "S", options: suppliers } } })
      const [error] = await choices.resolve("nord")
      expect(error?.code).toBe("DECISIONS_R0005")
      expect(error?.message).toContain("rejected the API key with HTTP 401")
      expect(error?.fix).toBe("Set or rotate TYPESAFE_API_KEY.")
    })

    it.each([
      new Error("provider token secret at https://internal.test"),
      Object.assign(new Error("custom gateway secret"), { fix: "Use secret-token" }),
      new DOMException("abort reason with secret-token", "AbortError"),
      "provider body with secret-token",
      null,
      undefined,
    ])("keeps an unknown gateway failure private: %s", async (cause) => {
      const choices = defineChoices({ gateway: { ask: async () => { throw cause } }, groups: { s: { label: "S", options: suppliers } } })
      const [error] = await choices.resolve("nord")
      expect(error?.code).toBe("DECISIONS_R0005")
      expect(error?.message).toBe("[vitehub] The gateway request failed.")
      expect(error?.fix).toBe("Read error.cause for the gateway error.")
      expect(error?.cause).toBe(cause)
    })

    it("keeps a non-transient provider failure private", async () => {
      vi.stubEnv("TYPESAFE_API_KEY", "fake-key")
      vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { message: "internal provider secret-token" } }, { status: 400 })))
      const choices = defineChoices({ gateway: typesafe(), groups: { s: { label: "S", options: suppliers } } })
      const [error] = await choices.resolve("nord")
      expect(error?.code).toBe("DECISIONS_R0005")
      expect(error?.message).toBe("[vitehub] The gateway request failed.")
      expect(error?.fix).toBe("Read error.cause for the gateway error.")
      expect(error?.cause).toBeInstanceOf(Error)
    })

    it("keeps an AI SDK model failure private", async () => {
      const cause = new Error("model provider secret-token")
      const model = new MockLanguageModelV3({ doGenerate: async () => { throw cause } })
      const choices = defineChoices({ model, groups: { s: { label: "S", options: suppliers } } })
      const [error] = await choices.resolve("nord")
      expect(error?.code).toBe("DECISIONS_R0005")
      expect(error?.message).toBe("[vitehub] The gateway request failed.")
      expect(error?.fix).toBe("Read error.cause for the gateway error.")
      expect(error?.cause).toBe(cause)
    })
  })

  it("throws when you define it wrong", () => {
    const gateway = wordGateway()
    expect(() => defineChoices({ gateway, groups: {} })).toThrow(/at least one group/)
    expect(() => defineChoices({ gateway: {} as never, groups: { a: { label: "A", options: [] } } })).toThrow(/gateway with ask/)
    expect(() => defineChoices({ gateway, groups: { a: { label: " ", options: [] } } })).toThrow(/needs a label/)
    expect(() => defineChoices({ gateway, groups: { a: { label: "A", options: [] } }, thresholds: { option: 2 } })).toThrow(/thresholds\.option/)
  })
})

describe("defineChoices().inspect()", () => {
  it("returns the state and questions without calling the gateway", async () => {
    const calls: Parameters<typeof wordGateway>[0] = []
    const [error, plan] = await forecast(calls).inspect("nord parts")
    expect(error).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(plan?.state.query).toBe("nord parts")
    expect(plan?.state.groups.map(group => group.label)).toEqual(["Chart", "Supplier"])
    expect(Object.keys(plan?.questions ?? {})).toContain("supported")
  })
})

describe("toOptions()", () => {
  it("maps items and leaves out empty aliases and descriptions", () => {
    expect(toOptions([{ id: 1, n: "A", a: ["x"], d: "first" }, { id: 2, n: "B", a: [], d: " " }], { aliases: item => item.a, description: item => item.d, label: item => item.n, value: item => item.id })).toEqual([
      { aliases: ["x"], description: "first", label: "A", value: 1 },
      { label: "B", value: 2 },
    ])
  })
})
