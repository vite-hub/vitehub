import { describe, expectTypeOf, it } from "vitest"

import type { ChoicesError } from "../src/index.ts"
import { defineChoices } from "../src/index.ts"
import { wordGateway } from "../src/testing.ts"

describe("defineChoices types", () => {
  it("types selections from the declared options", async () => {
    const choices = defineChoices({
      gateway: wordGateway(),
      groups: {
        chart: { label: "Chart", multiple: false, options: [{ label: "Line", value: "line" }, { label: "Bar", value: "bar" }] },
        year: { label: "Year", options: [{ label: "2025", value: 2025 }] },
      },
    })
    const [error, selection] = await choices.resolve("bar")
    if (error) return
    expectTypeOf(selection.chart.value).toEqualTypeOf<"bar" | "line" | null>()
    expectTypeOf(selection.year.include).toEqualTypeOf<2025[]>()
  })

  it("narrows the error code", async () => {
    const choices = defineChoices({
      gateway: wordGateway(),
      groups: { chart: { label: "Chart", multiple: false, options: [{ label: "Line", value: "line" }] } },
    })
    const [error] = await choices.resolve("line")
    expectTypeOf(error).toEqualTypeOf<ChoicesError | undefined>()
    if (!error) return
    expectTypeOf(error.code).toEqualTypeOf<"DECISIONS_R0002" | "DECISIONS_R0003" | "DECISIONS_R0004" | "DECISIONS_R0005" | "DECISIONS_R0006">()
    // @ts-expect-error defineChoices() throws DECISIONS_R0001, so resolve() never returns it.
    if (error.code === "DECISIONS_R0001") return
  })

  it("asks for context only when the options need it", () => {
    const needs = defineChoices({
      gateway: wordGateway(),
      groups: { site: { label: "Site", options: async (_context: { tenant: string }) => [{ label: "A", value: "a" }] } },
    })
    // @ts-expect-error The options function needs a tenant.
    void needs.resolve("a")
    // @ts-expect-error The context has the wrong shape.
    void needs.resolve("a", { context: { tenant: 1 } })
    void needs.resolve("a", { context: { tenant: "acme" } })
  })

  it("keeps required context when static groups are present", () => {
    const choices = defineChoices({
      gateway: wordGateway(),
      groups: {
        chart: { label: "Chart", options: [{ label: "Bar", value: "bar" }] },
        site: { label: "Site", options: async (_context: { tenant: string }) => [{ label: "A", value: "a" }] },
      },
    })
    // @ts-expect-error The static group must not erase the tenant requirement.
    void choices.resolve("a")
    // @ts-expect-error Inspection loads the same request-scoped options.
    void choices.inspect("a")
    // @ts-expect-error The context has the wrong shape.
    void choices.resolve("a", { context: { tenant: 1 } })
    void choices.resolve("a", { context: { tenant: "acme" } })
    void choices.inspect("a", { context: { tenant: "acme" } })
  })

  it("intersects the context of every loader alongside static groups", () => {
    const choices = defineChoices({
      gateway: wordGateway(),
      groups: {
        chart: { label: "Chart", options: [{ label: "Bar", value: "bar" }] },
        site: { label: "Site", options: async (_context: { tenant: string }) => [{ label: "A", value: "a" }] },
        user: { label: "User", options: (_context: { userId: number }) => [{ label: "B", value: "b" }] },
      },
    })
    // @ts-expect-error Both loader parameters are required.
    void choices.resolve("a", { context: { tenant: "acme" } })
    // @ts-expect-error Both loader parameters are required.
    void choices.inspect("b", { context: { userId: 1 } })
    void choices.resolve("a", { context: { tenant: "acme", userId: 1 } })
  })
})
