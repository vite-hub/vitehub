import { expectTypeOf, it } from "vitest"
import { cancelWorkflow, createWorkflow, getWorkflowRun, resumeWorkflow, startWorkflow } from "../src/runtime/client.ts"

import type { Result } from "@vite-hub/runtime"
import type { WorkflowHandle, WorkflowResultErrorCode, WorkflowRun, WorkflowSignalResult, WorkflowStartOptions } from "../src/types.ts"

it("requires input only when the Workflow requires it", () => {
  expectTypeOf<Parameters<WorkflowHandle<{ message: string }>["start"]>>().toEqualTypeOf<[payload: { message: string }, options?: WorkflowStartOptions]>()
  expectTypeOf<Parameters<WorkflowHandle<{ message: string } | undefined>["defer"]>>().toEqualTypeOf<[payload?: { message: string }, options?: WorkflowStartOptions]>()
  expectTypeOf<Parameters<WorkflowHandle<void>["start"]>>().toEqualTypeOf<[payload?: void, options?: WorkflowStartOptions]>()
  const required = createWorkflow<{ message: string }, string>("required", ({ payload }) => payload.message)
  void required.start({ message: "hello" })
  void required.defer({ message: "hello" }, { id: "job-1" })
  void required.start({ message: "hello" }, { delay: "1 hour", id: "job-2" })
  void required.start({ message: "hello" }, { delay: new Date("2026-12-01T09:00:00Z") })
  // @ts-expect-error A delay is a duration string or a Date.
  void required.start({ message: "hello" }, { delay: true })
  // @ts-expect-error A delay is a duration string, not a number.
  void required.start({ message: "hello" }, { delay: 60_000 })
  // @ts-expect-error Required payload cannot be omitted.
  void required.start()
  // @ts-expect-error Required payload cannot be omitted for deferred runs.
  void required.defer()
  // @ts-expect-error Undefined is not a required payload.
  void required.start(undefined)
  const optional = createWorkflow<{ message: string } | undefined>("optional", ({ payload }) => payload?.message)
  void optional.start()
  void optional.defer(undefined, { id: "job-2" })
  const noInput = createWorkflow<void>("no-input", () => "done")
  void noInput.start()
  void noInput.defer()
})

it("returns [error, data] from the Workflow calls", () => {
  expectTypeOf(startWorkflow).returns.resolves.toEqualTypeOf<Result<WorkflowRun<unknown, unknown>, WorkflowResultErrorCode>>()
  expectTypeOf(getWorkflowRun).returns.resolves.toEqualTypeOf<Result<WorkflowRun<unknown, unknown>, WorkflowResultErrorCode>>()
  expectTypeOf(cancelWorkflow).returns.resolves.toEqualTypeOf<Result<WorkflowRun<unknown, unknown>, WorkflowResultErrorCode>>()
  expectTypeOf(resumeWorkflow).returns.resolves.toEqualTypeOf<Result<WorkflowSignalResult, WorkflowResultErrorCode>>()
  expectTypeOf<ReturnType<WorkflowHandle<{ message: string }, string>["start"]>>().resolves.toEqualTypeOf<Result<WorkflowRun<{ message: string }, string>, WorkflowResultErrorCode>>()
})
