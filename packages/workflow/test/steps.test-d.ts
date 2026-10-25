import { expectTypeOf, it } from "vitest"
import { defineWorkflow } from "../src/definition.ts"
import type { WorkflowProviderContext, WorkflowStepRunner } from "../src/types.ts"

it("gives handlers a step runner without a non-null assertion", () => {
  defineWorkflow<{ email: string }>(async ({ payload, steps }) => {
    expectTypeOf(steps).toEqualTypeOf<WorkflowStepRunner>()
    const user = await steps.createUser(payload)
    return await steps.sendWelcome(user)
  })
})

it("does not give Vercel native entries a step runner", () => {
  defineWorkflow<{ email: string }>(({ payload }) => payload.email, {
    native: (context) => {
      expectTypeOf(context).toEqualTypeOf<WorkflowProviderContext<{ email: string }>>()
      return context.payload.email
    },
  })
})
