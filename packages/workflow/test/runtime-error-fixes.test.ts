import { describe, expect, it } from "vitest"

import { workflowErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createWorkflow, resumeWorkflow } from "../src/index.ts"
import { createOpenWorkflowWorker } from "../src/runtime/openworkflow-worker.ts"
import { validatePayload } from "../src/runtime/payload.ts"
import { unwrap } from "./unwrap.ts"

/** The runtime codes that the Workflow client, its providers, and the Vercel and Cloudflare output can raise. */
const runtimeCodes = [
  "WORKFLOW_R0001", "WORKFLOW_R0003", "WORKFLOW_R0004", "WORKFLOW_R0005", "WORKFLOW_R0006",
  "WORKFLOW_R0008", "WORKFLOW_R0009", "WORKFLOW_R0010", "WORKFLOW_R0011", "WORKFLOW_R0012",
  "WORKFLOW_R0013", "WORKFLOW_R0014", "WORKFLOW_R0015", "WORKFLOW_R0017",
  "WORKFLOW_R0018", "WORKFLOW_R0019", "WORKFLOW_R0020", "WORKFLOW_R0021", "WORKFLOW_R0022",
  "WORKFLOW_R0023", "WORKFLOW_R0024", "WORKFLOW_R0025", "WORKFLOW_R0026", "WORKFLOW_R0027",
  "WORKFLOW_R0028", "WORKFLOW_R0029", "WORKFLOW_R0030",
] as const

describe("Workflow runtime error fixes", () => {
  it.each(runtimeCodes)("gives %s a fix and its own docs page", (code) => {
    const error = workflowErrorDiagnostics[code]({ message: "m" })
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/workflows/diagnostics/${code.toLowerCase()}`)
  })

  it("shows how to call createWorkflow() without a name", () => {
    // SAFETY: The test sends the options that the public type rejects.
    expect(() => createWorkflow({ handler: async () => {} } as never)).toThrow(expect.objectContaining({
      code: "WORKFLOW_R0009",
      fix: expect.stringContaining("createWorkflow({ name, handler })"),
    }))
  })

  it("names the signal token of resumeWorkflow()", async () => {
    expect(await resumeWorkflow("", {})).toMatchObject([{
      code: "WORKFLOW_R0014",
      fix: expect.stringContaining("signal token"),
    }, undefined])
  })

  it("names the schema methods that validatePayload() reads", async () => {
    await expect(validatePayload("hello", {} as never)).rejects.toMatchObject({
      code: "WORKFLOW_R0022",
      fix: expect.stringContaining("`safeParse()`"),
    })
  })

  it("names the driver option of an OpenWorkflow worker", async () => {
    await expect(createOpenWorkflowWorker({ config: { driver: "vercel" } as never })).rejects.toMatchObject({
      code: "WORKFLOW_R0017",
      fix: expect.stringContaining("driver: \"openworkflow\""),
    })
  })
})
