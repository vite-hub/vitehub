import { expectTypeOf, it } from "vitest"
import { defineWorkflow } from "../src/definition.ts"

it("types context.sleep() with the duration form that every provider reads the same way", () => {
  defineWorkflow("nap", async (_payload: undefined, { sleep, step }) => {
    expectTypeOf(sleep).returns.resolves.toBeVoid()
    await sleep("1 day")
    await sleep("2 hours")
    await sleep("1.5 minutes")
    await sleep(5_000)
    await sleep(new Date())
    // @ts-expect-error A short unit such as `5s` is not portable.
    await sleep("5s")
    // @ts-expect-error The unit needs a space before it.
    await sleep("1day")
    // @ts-expect-error The provider sleep is not part of the handler context. Use `context.sleep()`.
    await step?.sleep?.("nap", 1_000)
  })
})
