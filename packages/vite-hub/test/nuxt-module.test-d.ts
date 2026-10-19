import type { NuxtConfig } from "nuxt/schema"
import { it } from "vitest"

import viteHubNuxtModule from "vite-hub/nuxt"

it("registers the imported module in Nuxt config", () => {
  const config: NuxtConfig = { modules: [viteHubNuxtModule, [viteHubNuxtModule, { agent: false }]] }
  void config
})
