import { expectTypeOf, it } from "vitest"

import type { LanguageModel } from "ai"
import type { AskModel } from "../src/index.ts"

it("accepts AI SDK models through the optional SDK boundary", () => {
  expectTypeOf<LanguageModel>().toExtend<AskModel>()
})
