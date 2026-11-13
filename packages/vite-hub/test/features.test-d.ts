import { expectTypeOf, it } from "vitest"

import type { FeatureId } from "@vite-hub/internal/features"
import type { SandboxTaskOptions } from "vite-hub"

import type { ViteHubOptions } from "../src/index.ts"

it("exports the Sandbox Task owner options", () => {
  expectTypeOf<SandboxTaskOptions>().toEqualTypeOf<import("@vite-hub/sandbox/task/vite").SandboxTaskOptions>()
})

it("lists every feature key of ViteHubOptions", () => {
  expectTypeOf<FeatureId>().toEqualTypeOf<Exclude<keyof ViteHubOptions, "bundle" | "cloudflare" | "dataDir" | "name" | "node" | "host" | "publicUrl" | "systemd">>()
})
