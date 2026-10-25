import { expectTypeOf, it } from "vitest"
import { defineWorkflow } from "../src/definition.ts"
import type { WorkflowDefinitionRegistry } from "../src/types.ts"

it("accepts definitions with a typed payload without a cast", () => {
  const onboardUser = defineWorkflow<{ email: string }>(async ({ payload }) => ({ userId: `user:${payload.email}` }))
  const untyped = defineWorkflow(async ({ payload }) => payload)

  const registry = {
    "onboard-user": async () => onboardUser,
    "onboard-user-module": async () => ({ default: onboardUser }),
    "onboard-user-import": () => import("./fixtures/typed-payload-workflow.ts"),
    "untyped": async () => untyped,
  } satisfies WorkflowDefinitionRegistry

  expectTypeOf(registry).toExtend<WorkflowDefinitionRegistry>()
})

it("still rejects values that are not Workflow definitions", () => {
  const registry = {
    // @ts-expect-error A registry loader must return a Workflow definition or a module.
    "not-a-definition": async () => "onboard-user",
  } satisfies WorkflowDefinitionRegistry

  void registry
})
