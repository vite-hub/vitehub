import { defineChoices } from "../../../../src/index.ts"
import { wordGateway } from "../../../support.ts"

console.log("module log")
const gateway = wordGateway()

export const logging = defineChoices({
  gateway: {
    ask: async (...args) => {
      process.stdout.write("gateway log\n")
      return gateway.ask(...args)
    },
  },
  groups: {
    site: {
      label: "Site",
      options: () => {
        console.log("options log")
        return [{ label: "Berlin", value: "ber" }]
      },
    },
  },
  name: "logging",
})
