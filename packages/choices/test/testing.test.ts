import { describe, expect, it } from "vitest"

import { answers, scriptedAsk } from "@vite-hub/gateways/testing"
import { defineChoices } from "../src/index.ts"
import { selectionGateway, unsupported } from "../src/testing.ts"

const groups = {
  chart: { label: "Chart", multiple: false, options: [{ label: "Line", value: "line" }, { label: "Bar", value: "bar" }] },
  supplier: { label: "Supplier", options: [{ label: "Vak Supply", value: "S1" }, { label: "Nord Parts", value: "S2" }, { label: "Vakuum Co", value: "S3" }] },
} as const

describe("selectionGateway()", () => {
  it("returns the selection that you give, by group key and option value", async () => {
    const choices = defineChoices({ gateway: selectionGateway<typeof groups>({ chart: "bar", supplier: { exclude: ["S1"], include: ["S2"] } }), groups })
    const [error, selection] = await choices.resolve("anything")
    expect(error).toBeUndefined()
    expect(selection?.chart).toMatchObject({ confidence: 1, value: "bar" })
    expect(selection?.supplier).toEqual({ exclude: ["S1"], include: ["S2"] })
  })

  it("selects nothing for a group that you leave out", async () => {
    const [, selection] = await defineChoices({ gateway: selectionGateway({}), groups }).resolve("anything")
    expect(selection).toMatchObject({ chart: { value: null }, supplier: { exclude: [], include: [] } })
  })

  it("answers from the text and the request context", async () => {
    const seen: unknown[] = []
    const sites = async (context: { tenant: string }) => [{ label: `${context.tenant} Mill`, value: context.tenant }]
    const siteGroups = { site: { label: "Site", options: sites } }
    const gateway = selectionGateway<typeof siteGroups>((text, context) => {
      seen.push([text, context])
      return { site: { include: [context.tenant] } }
    })
    const [, selection] = await defineChoices({ gateway, groups: siteGroups }).resolve(" acme ", { context: { tenant: "acme" } })
    expect(selection?.site.include).toEqual(["acme"])
    expect(seen).toEqual([["acme", { tenant: "acme" }]])
  })

  it("gives an infer group no value when you leave it out", async () => {
    const options = [{ label: "Docs", value: "docs" }, { label: "Console", value: "console" }, { label: "Thai", value: "thai" }]
    const [, selection] = await defineChoices({ gateway: selectionGateway({}), groups: { project: { infer: true, label: "Project", multiple: false, options } } }).resolve("x")
    expect(selection?.project.value).toBeNull()
  })

  it("returns DECISIONS_R0004 for unsupported", async () => {
    const [error] = await defineChoices({ gateway: selectionGateway(unsupported), groups }).resolve("price above 100")
    expect(error?.code).toBe("DECISIONS_R0004")
  })

  it("returns DECISIONS_R0005 when the function throws", async () => {
    const cause = new Error("offline")
    const [error] = await defineChoices({ gateway: selectionGateway(() => { throw cause }), groups }).resolve("x")
    expect(error).toMatchObject({ cause, code: "DECISIONS_R0005" })
  })

  it("returns DECISIONS_R0005 for an unknown group or value, with DECISIONS_TESTING_SELECTION_INVALID as the cause", async () => {
    for (const selection of [{ shipper: "x" }, { chart: "pie" }, { chart: { include: ["line"] } }, { supplier: "S1" }]) {
      const [error] = await defineChoices({ gateway: selectionGateway(selection), groups }).resolve("x")
      expect(error?.code).toBe("DECISIONS_R0005")
      expect(error?.cause).toMatchObject({ code: "DECISIONS_TESTING_SELECTION_INVALID" })
    }
  })

  it("throws outside defineChoices()", async () => {
    await expect(selectionGateway({}).ask("x", {})).rejects.toMatchObject({ code: "DECISIONS_TESTING_SELECTION_INVALID" })
  })
})

describe("scriptedAsk() with defineChoices()", () => {
  it("returns DECISIONS_R0005 with the public reason of a rejected key", async () => {
    const { gateway } = scriptedAsk((_key, question) => answers.first(question), { error: "GATEWAYS_R0008" })
    const [error] = await defineChoices({ gateway, groups }).resolve("x")
    expect(error?.code).toBe("DECISIONS_R0005")
    expect(error?.message).toContain("rejected the API key with HTTP 401")
    expect(error?.fix).toBe("Pass a valid apiKey to the gateway, or rotate the key.")
  })
})
