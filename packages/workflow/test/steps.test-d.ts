import { expectTypeOf, it } from "vitest"
import { defineWorkflow } from "../src/definition.ts"
import type { WorkflowProviderContext, WorkflowStep, WorkflowStepContext } from "../src/types.ts"

it("types the payload from the type argument", () => {
  const onboard = defineWorkflow<{ email: string }>({
    handler: async ({ payload, steps }) => {
      expectTypeOf(steps).toEqualTypeOf<{ readonly [TStep in never]: never }>()
      return payload.email
    },
  })
  expectTypeOf(onboard.handler).parameter(0).toHaveProperty("payload").toEqualTypeOf<{ email: string }>()
})

it("infers the result of the handler when the payload comes from its parameter", () => {
  const onboard = defineWorkflow({
    handler: async ({ payload }: { payload: { email: string } }) => ({ userId: `user:${payload.email}` }),
  })
  expectTypeOf(onboard.handler).returns.resolves.toEqualTypeOf<{ userId: string }>()
})

it("preserves optional and defaulted step inputs without weakening required inputs", () => {
  const defaulted = (input = { limit: 10 }) => input.limit
  expectTypeOf<WorkflowStep<typeof defaulted>>().parameters.toEqualTypeOf<[input?: { limit: number }]>()
  expectTypeOf<WorkflowStep<(input?: { limit: number }) => string[]>>().returns.resolves.toEqualTypeOf<string[]>()
  expectTypeOf<WorkflowStep<() => string>>().parameters.toEqualTypeOf<[]>()
  expectTypeOf<WorkflowStep<(input: string | undefined) => string>>().parameters.toEqualTypeOf<[input: string | undefined]>()
})

it("gives a Workflow without a payload type an undefined payload", () => {
  const flat = defineWorkflow({ handler: async ({ payload }) => payload })
  expectTypeOf(flat.handler).parameter(0).toHaveProperty("payload").toEqualTypeOf<undefined>()
})

it("does not give Vercel native entries a step runner", () => {
  defineWorkflow<{ email: string }>({
    handler: ({ payload }) => payload.email,
    native: (context) => {
      expectTypeOf(context).toEqualTypeOf<WorkflowProviderContext<{ email: string }>>()
      return context.payload.email
    },
  })
})

it("rejects a name and unknown options", () => {
  // @ts-expect-error The file path is the Workflow name.
  defineWorkflow({ handler: async () => undefined, name: "onboard-user" })
  // @ts-expect-error `defineWorkflow()` takes one object.
  defineWorkflow("onboard-user", async () => undefined)
})

it("calls a step that reads the step context with its input only", () => {
  expectTypeOf<WorkflowStep<(input: { repo: string }, context: WorkflowStepContext) => string>>().parameters.toEqualTypeOf<[input: { repo: string }]>()
})
