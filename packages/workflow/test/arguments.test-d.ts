import { expectTypeOf, it } from "vitest"
import { createWorkflow } from "../src/runtime/client.ts"
import type { WorkflowHandle } from "../src/types.ts"

it("requires input only when the Workflow requires it", () => {
  expectTypeOf<Parameters<WorkflowHandle<{ message: string }>["start"]>>().toEqualTypeOf<[payload: { message: string }, options?: { id?: string }]>()
  expectTypeOf<Parameters<WorkflowHandle<{ message: string } | undefined>["defer"]>>().toEqualTypeOf<[payload?: { message: string }, options?: { id?: string }]>()
  expectTypeOf<Parameters<WorkflowHandle<void>["start"]>>().toEqualTypeOf<[payload?: void, options?: { id?: string }]>()
  const required = createWorkflow("required", (payload: { message: string }) => payload.message)
  void required.start({ message: "hello" })
  void required.defer({ message: "hello" }, { id: "job-1" })
  // @ts-expect-error Required payload cannot be omitted.
  void required.start()
  // @ts-expect-error Required payload cannot be omitted for deferred runs.
  void required.defer()
  // @ts-expect-error Undefined is not a required payload.
  void required.start(undefined)
  const optional = createWorkflow<{ message: string } | undefined>("optional", (payload) => payload?.message)
  void optional.start()
  void optional.defer(undefined, { id: "job-2" })
  const noInput = createWorkflow<void>("no-input", () => "done")
  void noInput.start()
  void noInput.defer()
})
