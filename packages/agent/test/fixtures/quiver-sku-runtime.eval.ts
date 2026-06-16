import { defineEval, textContains } from "../../src/eval.ts"
import type { QuiverPortalRuntimeConfig } from "./quiver-sku-runtime.ts"

export default defineEval<QuiverPortalRuntimeConfig>({
  runtimeConfig: () => ({
    portal: {
      forecast: {
        next60DaysDemand: 350,
        peakMonth: "August",
      },
      inventory: {
        onHand: 300,
        safetyStock: 200,
      },
      planningGroup: "EU Wholesale",
      purchaseOrders: [{
        eta: "2026-07-24",
        quantity: 120,
        reference: "PO-7721",
      }],
      selectedSku: "RAIN-042-BLK",
    },
  }),
  scenarios: [{
    input: {
      prompt: "For the selected SKU, should we increase the next purchase order before the August forecast peak, or wait for more sales data?",
    },
    name: "selected SKU purchase order forecast",
    scorers: [
      textContains("Selected SKU RAIN-042-BLK"),
      textContains("shortfall of 130"),
      textContains("PO-7721"),
    ],
  }],
})
