import { afterAll, expect, it } from "vitest"

import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import { setQueueRuntimeConfig } from "../src/internal/runtime/state.ts"
import { dynamicQueue } from "../src/runtime/client.ts"

const mode = enableViteHubTestMode()

afterAll(async () => {
  await mode.reset()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
  setQueueRuntimeConfig(undefined)
})

it("records every send without a Definition or a provider, and a reset empties the list", async () => {
  // A disabled Queue and no Definitions: test mode needs neither.
  setQueueRuntimeConfig(false)

  expect(await dynamicQueue.run("welcome", { userId: 1 }, { delaySeconds: 60, id: "job-1" })).toEqual([undefined, { messageId: "job-1", status: "queued" }])
  dynamicQueue.defer("welcome", { userId: 2 })
  const queue = await dynamicQueue.get("digest")
  const [error, sent] = await queue.sendBatch([{ body: { day: 1 } }], { delaySeconds: 5 })

  expect(error).toBeUndefined()
  expect(sent).toHaveLength(1)
  expect(mode.peek("queue")).toMatchObject([
    { id: "job-1", options: { delaySeconds: 60 }, payload: { userId: 1 }, queue: "welcome" },
    { options: {}, payload: { userId: 2 }, queue: "welcome" },
    { options: { delaySeconds: 5 }, payload: { day: 1 }, queue: "digest" },
  ])

  await mode.reset()
  expect(mode.peek("queue")).toBeUndefined()
})
