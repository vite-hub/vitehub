import { expectTypeOf, it } from "vitest"

import type { FeatureId } from "@vite-hub/internal/features"
import type { SandboxTaskOptions } from "vite-hub"

import type { ViteHubOptions } from "../src/index.ts"

it("exports the Sandbox Task owner options", () => {
  expectTypeOf<SandboxTaskOptions>().toEqualTypeOf<import("@vite-hub/sandbox/task/vite").SandboxTaskOptions>()
})

it("lists every feature key of ViteHubOptions", () => {
  // `device` configures the Nuxt plugin of `@vite-hub/device`, which installing the package turns on, as with Forms.
  // `vitehub add` writes `<feature>: true`, and `logs: true` fails a production build, so `logs` is set by hand.
  // `webContainer` needs its routes, so it is set by hand too.
  expectTypeOf<FeatureId>().toEqualTypeOf<Exclude<keyof ViteHubOptions, "bundle" | "cloudflare" | "dataDir" | "deploy" | "device" | "docker" | "health" | "logs" | "name" | "node" | "host" | "publicUrl" | "redirects" | "sameOriginWrites" | "security" | "seo" | "systemd" | "trustProxy" | "webContainer">>()
})
