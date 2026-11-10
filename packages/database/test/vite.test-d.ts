import type {} from "nitro/vite"
import type { NitroModule } from "nitro/types"

import { expectTypeOf, it } from "vitest"

import { hubDatabase } from "../src/vite.ts"

it("supports Nitro's Vite Plugin augmentation", () => {
  expectTypeOf(hubDatabase().nitro).toMatchTypeOf<NitroModule>()
})
