import { describe, expect, it } from "vitest"

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
  it("maps items and leaves out empty aliases", () => {
    expect(toOptions([{ id: 1, n: "A", a: ["x"] }, { id: 2, n: "B", a: [] }], { aliases: item => item.a, label: item => item.n, value: item => item.id })).toEqual([
      { aliases: ["x"], label: "A", value: 1 },
      { label: "B", value: 2 },
    ])
  })
})
