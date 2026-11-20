import { describe, expectTypeOf, it } from "vitest"

import { defineChoices } from "../src/index.ts"
import { useChoices } from "../src/vue.ts"
import { wordGateway } from "./support.ts"

import type { MultipleSelection, SingleSelection } from "../src/index.ts"
import type { ChoicesSelectionOf } from "../src/vue.ts"

const forecast = defineChoices({
  gateway: wordGateway(),
  groups: {
    chart: { label: "Chart", multiple: false, options: [{ label: "Line", value: "line" }, { label: "Bar", value: "bar" }] },
    supplier: { label: "Supplier", options: [{ label: "Nord", value: "S2" }] },
  },
})

describe("useChoices types", () => {
  it("types the selection from the Choices type", () => {
    type Selection = ChoicesSelectionOf<typeof forecast>
    expectTypeOf<Selection["chart"]>().toEqualTypeOf<SingleSelection<"bar" | "line">>()
    expectTypeOf<Selection["supplier"]>().toEqualTypeOf<MultipleSelection<"S2">>()
    const choices = useChoices<typeof forecast>({
      onSelect: selection => expectTypeOf(selection.supplier.include).toEqualTypeOf<"S2"[]>(),
      resolve: async () => ({ chart: { confidence: 1, ranked: [], value: null }, supplier: { exclude: [], include: [] } }),
    })
    expectTypeOf(choices.selection.value?.chart.value).toEqualTypeOf<"bar" | "line" | null | undefined>()
  })
})
