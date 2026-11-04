import { defineChoices, toOptions } from "vite-hub/decisions"
import { wordGateway } from "./word-gateway"

// Your data. In a real app it comes from a database.
const suppliers = [
  { id: "nord", name: "Nord Parts" },
  { id: "vak", name: "Vak Supply" },
  { id: "alto", name: "Alto Metals" },
]

export const forecast = defineChoices({
  name: "forecast", // a label for logs. It connects nothing.
  gateway: wordGateway,
  groups: {
    supplier: {
      label: "Supplier",
      options: toOptions(suppliers, { value: s => s.id, label: s => s.name, aliases: s => [s.id] }),
    },
    chart: {
      label: "Chart",
      multiple: false, // choose at most one
      options: [{ value: "line", label: "Line" }, { value: "bar", label: "Bar" }],
    },
  },
})
