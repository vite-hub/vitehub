import type { DatabaseExtendContext } from "./index.js"

declare module "@nuxt/schema" {
  interface NuxtHooks {
    /** Adds schema files to a discovered ViteHub Database. Runs once per Database after all modules are installed. */
    "vitehub:database:extend": (context: DatabaseExtendContext) => void | Promise<void>
  }
}
