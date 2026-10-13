import { expectTypeOf } from "vitest"

import { defineAgent } from "../src/index.ts"
import { gmail } from "../src/channels.ts"

const channels = { gmail: gmail() }

defineAgent({
  channels,
  driver: { run: () => "ok" },
  intercept: ({ data }) => {
    // Channel messages are available at runtime only for Channel-triggered runs.
    // Direct runs and trigger-produced input.data remain unknown here.
    expectTypeOf(data).toEqualTypeOf<unknown>()
    return undefined
  },
})

defineAgent({
  channels,
  driver: { run: () => "ok" },
  intercept: ({ data }) => {
    expectTypeOf(data).toEqualTypeOf<unknown>()
    return undefined
  },
  workspace: {},
})
