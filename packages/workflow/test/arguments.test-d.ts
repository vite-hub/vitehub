import { expectTypeOf, it } from "vitest"
import { createWorkflow } from "../src/runtime/client.ts"
import type { WorkflowHandle } from "../src/types.ts"

it("requires input only when the Workflow requires it", () => {
  expectTypeOf<Parameters<WorkflowHandle<{ message: string }>["run"]>>().toEqualTypeOf<[payload: { message: string }, options?: { id?: string }]>()
  expectTypeOf<Parameters<WorkflowHandle<{ message: string } | undefined>["defer"]>>().toEqualTypeOf<[payload?: { message: string }, options?: { id?: string }]>()
  expectTypeOf<Parameters<WorkflowHandle<void>["run"]>>().toEqualTypeOf<[payload?: void, options?: { id?: string }]>()
  const required = createWorkflow("required", ({ payload }: { payload: { message: string } }) => payload.message)
  void required.run({ message: "hello" })
  void required.defer({ message: "hello" }, { id: "job-1" })
  // @ts-expect-error Required payload cannot be omitted.
  void required.run()
  // @ts-expect-error Required payload cannot be omitted for deferred runs.
  void required.defer()
  // @ts-expect-error Undefined is not a required payload.
  void required.run(undefined)
  const optional = createWorkflow<{ message: string } | undefined>("optional", ({ payload }) => payload?.message)
  void optional.run()
  void optional.defer(undefined, { id: "job-2" })
  const noInput = createWorkflow<void>("no-input", () => "done")
  void noInput.run()
  void noInput.defer()
})
