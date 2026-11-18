import { expectTypeOf, it } from "vitest"

import type { LanguageModel } from "ai"
import type { AskError, AskModel, AskResult } from "../src/index.ts"
import { ask } from "../src/index.ts"

it("accepts AI SDK models through the optional SDK boundary", () => {
  expectTypeOf<LanguageModel>().toExtend<AskModel>()
})

it("returns text without a schema and typed data with one", () => {
  const schema = { "~standard": { types: undefined as { input: unknown, output: { merchant: string } } | undefined, validate: (value: unknown) => ({ value }), vendor: "test", version: 1 as const } }
  expectTypeOf(ask("Summarize this run", { model: "openai/gpt-5.1-mini" })).resolves.toEqualTypeOf<AskResult<string>>()
  expectTypeOf(ask("Read the receipt", { model: "openai/gpt-5.1-mini", schema })).resolves.toEqualTypeOf<AskResult<{ merchant: string }>>()
  expectTypeOf<AskError["code"]>().toEqualTypeOf<"GATEWAYS_ASK_MODEL_FAILED" | "GATEWAYS_ASK_OUTPUT_INVALID">()
})
