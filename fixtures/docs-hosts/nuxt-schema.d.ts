// The `vitehub` key that Nuxt adds to its config types from the module, as `nuxi prepare` writes it in a real app.
import type viteHubNuxt from "vite-hub/nuxt"

type ViteHubNuxtOptions = Partial<NonNullable<Parameters<typeof viteHubNuxt>[0]>>

declare module "nuxt/schema" {
  interface NuxtConfig {
    vitehub?: ViteHubNuxtOptions | false
  }
}

declare module "@nuxt/schema" {
  interface NuxtConfig {
    vitehub?: ViteHubNuxtOptions | false
  }
}
