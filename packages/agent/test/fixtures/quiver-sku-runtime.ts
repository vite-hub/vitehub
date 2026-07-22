import type { AgentDefinition } from "../../src/index.ts"

export interface QuiverPortalRuntimeConfig {
  portal: {
    forecast: {
      next60DaysDemand: number
      peakMonth: string
    }
    inventory: {
      onHand: number
      safetyStock: number
    }
    planningGroup: string
    purchaseOrders: Array<{
      eta: string
      quantity: number
      reference: string
    }>
    selectedSku: string
  }
}

const agent: AgentDefinition<QuiverPortalRuntimeConfig> = {
  authorizeExecution: () => true,
  name: "quiver-sku-runtime",
  async resolve(runtime) {
    const portal = runtime.runtimeConfig?.portal
    if (!portal) throw new TypeError("Quiver Portal runtime config is required.")

    return {
      name: "quiver-sku-runtime",
      generate({ input }) {
        const openPurchaseOrderQuantity = portal.purchaseOrders.reduce((total, order) => total + order.quantity, 0)
        const projectedStock = portal.inventory.onHand + openPurchaseOrderQuantity - portal.forecast.next60DaysDemand
        const shortfall = Math.max(0, portal.inventory.safetyStock - projectedStock)
        const firstPurchaseOrder = portal.purchaseOrders[0]

        return {
          text: [
            `Selected SKU ${portal.selectedSku} in ${portal.planningGroup}.`,
            `Question: ${input.prompt || "Should we adjust the purchase plan?"}`,
            `Projected stock after open purchase orders is ${projectedStock}, leaving a safety-stock shortfall of ${shortfall} for ${portal.forecast.peakMonth}.`,
            `Recommendation: increase the next purchase order by ${shortfall} units${firstPurchaseOrder ? `, using ${firstPurchaseOrder.reference} due ${firstPurchaseOrder.eta} as the baseline` : ""}.`,
          ].join(" "),
        }
      },
    }
  },
}

export default agent
