import { expectTypeOf, it } from "vitest"

import type { FeatureId } from "@vite-hub/internal/features"
import type { SandboxTaskOptions } from "vite-hub"

import type { ViteHubOptions } from "../src/index.ts"

it("exports the Sandbox Task owner options", () => {
  expectTypeOf<SandboxTaskOptions>().toEqualTypeOf<import("@vite-hub/sandbox/task/vite").SandboxTaskOptions>()
})

it("lists every feature key of ViteHubOptions", () => {
  // `device` configures the Nuxt plugin of `@vite-hub/device`, which installing the package turns on, as with Forms.
  expectTypeOf<FeatureId>().toEqualTypeOf<Exclude<keyof ViteHubOptions, "bundle" | "cloudflare" | "dataDir" | "device" | "health" | "name" | "node" | "host" | "publicUrl" | "sameOriginWrites" | "systemd" | "trustProxy">>()
})
