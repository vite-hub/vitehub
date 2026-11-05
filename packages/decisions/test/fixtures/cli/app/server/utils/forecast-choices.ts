import { defineChoices, toOptions } from "../../../../../../src/index.ts"
import { wordGateway } from "../../../../../support.ts"
// An extensionless import, as in app code.
import { suppliers } from "./suppliers"

export const forecast = defineChoices({
  gateway: wordGateway(),
  groups: {
    chart: { label: "Chart", multiple: false, options: [{ label: "Line", value: "line" }, { label: "Bar", value: "bar" }] },
    supplier: { label: "Supplier", options: toOptions(suppliers, { label: s => s.name, value: s => s.code }) },
  },
  name: "forecast",
})
