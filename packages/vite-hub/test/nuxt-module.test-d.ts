import type { NuxtConfig } from "nuxt/schema"
import { expectTypeOf, it } from "vitest"

import viteHubNuxtModule from "vite-hub/nuxt"

it("registers the imported module in Nuxt config", () => {
  const config: NuxtConfig = { modules: [viteHubNuxtModule, [viteHubNuxtModule, { agent: false }]] }
  void config
})

it("accepts Vite options in the Nuxt module", () => {
  viteHubNuxtModule({
    agent: false,
    console: false,
    host: "node",
    publicUrl(agent) {
      expectTypeOf(agent).toBeString()
      return `https://${agent}.example.com`
    },
  })
})
