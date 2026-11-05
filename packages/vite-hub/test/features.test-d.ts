import { expectTypeOf, it } from "vitest"

import type { FeatureId } from "@vite-hub/internal/features"

import type { ViteHubOptions } from "../src/index.ts"

it("lists every feature key of ViteHubOptions", () => {
  expectTypeOf<FeatureId>().toEqualTypeOf<Exclude<keyof ViteHubOptions, "cloudflare" | "contentImportBase" | "dataDir" | "name" | "preset" | "publicUrl">>()
})
