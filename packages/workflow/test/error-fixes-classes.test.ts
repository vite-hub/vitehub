import { afterEach, expect, it } from "vitest"

import { workflowErrorDiagnostics } from "../src/error-diagnostics.ts"
import { runWorkflowOperation } from "../src/runtime/operations.ts"
import { setWorkflowRuntimeConfig } from "../src/runtime/state.ts"

const codes = {
  WORKFLOW_DEFINITION_NOT_FOUND: workflowErrorDiagnostics.WORKFLOW_DEFINITION_NOT_FOUND({}),
  WORKFLOW_DISABLED: workflowErrorDiagnostics.WORKFLOW_DISABLED(),
  WORKFLOW_OPERATION_FAILED: workflowErrorDiagnostics.WORKFLOW_OPERATION_FAILED(),
  WORKFLOW_OPERATION_UNSUPPORTED: workflowErrorDiagnostics.WORKFLOW_OPERATION_UNSUPPORTED({ operation: "cancel", provider: "vercel" }),
  WORKFLOW_REGISTRY_MISSING: workflowErrorDiagnostics.WORKFLOW_REGISTRY_MISSING({ workflow: "welcome" }),
  WORKFLOW_RUN_AMBIGUOUS: workflowErrorDiagnostics.WORKFLOW_RUN_AMBIGUOUS({ id: "r1", workflows: "a, b" }),
  WORKFLOW_RUN_UNKNOWN: workflowErrorDiagnostics.WORKFLOW_RUN_UNKNOWN({ runId: "r1" }),
  WORKFLOW_RUNS_UNAVAILABLE: workflowErrorDiagnostics.WORKFLOW_RUNS_UNAVAILABLE(),
}

afterEach(() => {
  setWorkflowRuntimeConfig(undefined)
})

it("gives each code that replaced WorkflowOperationError a fix and its own docs page", () => {
  for (const [code, error] of Object.entries(codes)) {
    expect(error.code, code).toBe(code)
    expect(error.message, code).toMatch(/\S/)
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/workflows/diagnostics/${code.toLowerCase()}`)
  }
})

it("gives a disabled runtime WORKFLOW_DISABLED with status 409 and a fix", async () => {
  setWorkflowRuntimeConfig(false)
  await expect(runWorkflowOperation("get", { runId: "r1", workflow: "welcome" })).rejects.toMatchObject({
    code: "WORKFLOW_DISABLED",
    fix: expect.stringContaining("vitehub({ workflow: true })"),
    status: 409,
  })
})
