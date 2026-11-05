import { expectTypeOf, it } from "vitest"
import { defineWorkflow } from "../src/definition.ts"
import type { WorkflowProviderContext } from "../src/types.ts"

// The shape that `.vitehub/workflow.d.ts` declares for `server/workflows/onboard-user/`.
declare module "../src/types.ts" {
  interface WorkflowStepRegistry {
    "onboard-user": {
      createUser: typeof import("./fixtures/onboard-user/01.create-user.ts").default
      sendWelcome: typeof import("./fixtures/onboard-user/02.send-welcome.ts").default
    }
  }
}

it("types steps with the step files of the named Workflow", () => {
  const onboard = defineWorkflow("onboard-user", async (payload: { email: string }, { steps }) => {
    const user = await steps.createUser(payload)
    expectTypeOf(user).toEqualTypeOf<{ email: string, id: string }>()
    return await steps.sendWelcome(user)
  })
  expectTypeOf(onboard.handler).parameter(0).toEqualTypeOf<{ email: string }>()
  expectTypeOf(onboard.handler).returns.resolves.toEqualTypeOf<{ userId: string, welcomeSent: boolean }>()
})

it("rejects unknown steps and wrong step input", () => {
  defineWorkflow("onboard-user", async (payload: { name: string }, { steps }) => {
    // @ts-expect-error The step takes `{ email }`.
    await steps.createUser(payload)
    // @ts-expect-error No step file is named `chargeCard`.
    await steps.chargeCard(payload)
  })
})

it("gives a Workflow without step files no steps and an optional payload", () => {
  const flat = defineWorkflow("cleanup", async (_payload, { steps }) => {
    expectTypeOf(steps).toEqualTypeOf<{ readonly [TStep in never]: never }>()
    return "done"
  })
  expectTypeOf(flat.handler).parameter(0).toEqualTypeOf<undefined>()
})

it("does not give Vercel native entries a step runner", () => {
  defineWorkflow("onboard-user", (payload: { email: string }) => payload.email, {
    native: (context) => {
      expectTypeOf(context).toEqualTypeOf<WorkflowProviderContext<{ email: string }>>()
      return context.payload.email
    },
  })
})
