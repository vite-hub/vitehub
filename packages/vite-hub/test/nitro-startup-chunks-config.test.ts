import { expect, it } from "vitest"

import { nitroStartupChunks } from "../src/internal/nitro-startup-chunks.ts"

it("preserves explicitly disabled Rolldown code splitting", async () => {
  const config = { nitro: { rolldownConfig: { output: { codeSplitting: false } } } }
  const hook = nitroStartupChunks().config
  if (typeof hook !== "function") throw new TypeError("Expected a config hook.")

  await Reflect.apply(hook, {}, [config, { command: "build", mode: "production" }])

  expect(config.nitro.rolldownConfig.output.codeSplitting).toBe(false)
})
