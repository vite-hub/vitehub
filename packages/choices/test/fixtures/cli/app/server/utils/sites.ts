import { defineChoices } from "../../../../../../src/index.ts"
import { wordGateway } from "../../../../../support.ts"

const sitesByTenant: Record<string, { label: string, value: string }[]> = {
  t1: [{ label: "Berlin", value: "ber" }, { label: "Madrid", value: "mad" }],
}

export const sites = defineChoices({
  gateway: wordGateway(),
  groups: {
    site: { label: "Site", options: ({ tenantId }: { tenantId: string }) => sitesByTenant[tenantId] ?? [] },
  },
})

export const status = defineChoices({
  gateway: wordGateway(),
  groups: {
    status: { label: "Status", options: [{ label: "Open", value: "open" }, { label: "Closed", value: "closed" }] },
  },
  name: "status",
})
