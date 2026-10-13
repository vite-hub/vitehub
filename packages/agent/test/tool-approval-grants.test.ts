import { describe, expect, it, vi } from "vitest"

import {
  applyAgentToolPolicies,
  approveAgentToolRequest,
  copyToolWithOverrides,
  executeApprovedAgentTool,
  withAgentToolStepReporting,
  withJsonCompatibleToolOutputs,
} from "../src/tool-runtime.ts"

import type { AgentToolApprovalGrant } from "../src/tool-runtime.ts"
import type { AgentToolDefinition } from "../src/types.ts"

function approvalTool() {
  const execute = vi.fn(async (input: unknown) => input)
  const tools: Record<string, AgentToolDefinition> = applyAgentToolPolicies({ email_send: { execute, name: "email_send", policy: "require-approval" as const } })!
  return { execute, tool: tools.email_send! }
}

async function requestApproval(tool: AgentToolDefinition, input: unknown): Promise<unknown> {
  try {
    await tool.execute!(input)
  }
  catch (error) {
    expect(error).toMatchObject({ code: "APPROVAL_REQUIRED" })
    return (error as Error).cause
  }
  throw new Error("Expected the tool policy to require approval.")
}

describe("tool approval grants", () => {
  it("runs the approved call once with the approved input", async () => {
    const { execute, tool } = approvalTool()
    const input = { recipient: "team@example.com" }
    const request = await requestApproval(tool, input)
    const grant = approveAgentToolRequest(request)!

    expect(grant).toMatchObject({ toolName: "email_send" })
    expect(Object.isFrozen(grant)).toBe(true)
    expect(approveAgentToolRequest(request)).toBeUndefined()
    await expect(executeApprovedAgentTool(tool, grant)).resolves.toEqual(input)
    expect(execute).toHaveBeenCalledExactlyOnceWith(input, expect.any(Object))
    await expect(executeApprovedAgentTool(tool, grant)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(execute).toHaveBeenCalledOnce()
  })

  it("snapshots nested approved input separately from the caller and approval request", async () => {
    const { execute, tool } = approvalTool()
    const input = { message: { recipients: ["team@example.com"] } }
    const request = await requestApproval(tool, input) as { input: typeof input }
    request.input.message.recipients[0] = "changed@example.com"
    const grant = approveAgentToolRequest(request)!
    input.message.recipients.push("extra@example.com")
    request.input = { message: { recipients: ["replacement@example.com"] } }

    await expect(executeApprovedAgentTool(tool, grant)).resolves.toEqual({ message: { recipients: ["team@example.com"] } })
    expect(execute).toHaveBeenCalledOnce()
  })

  it("keeps the grant through tool output and step reporting wrappers", async () => {
    const { execute, tool } = approvalTool()
    const reportToolStep = vi.fn(async () => undefined)
    const wrapped = withAgentToolStepReporting(withJsonCompatibleToolOutputs({ email_send: tool }), reportToolStep).email_send!
    const input = { recipient: "team@example.com" }
    const grant = approveAgentToolRequest(await requestApproval(wrapped, input))!

    await expect(executeApprovedAgentTool(wrapped, grant)).resolves.toEqual(input)
    expect(execute).toHaveBeenCalledOnce()
    expect(reportToolStep).toHaveBeenCalledWith(expect.objectContaining({ toolResults: [expect.objectContaining({ output: input })] }))
  })

  it("rejects forged requests and forged grants", async () => {
    const { execute, tool } = approvalTool()
    const request = await requestApproval(tool, { recipient: "team@example.com" })

    expect(approveAgentToolRequest({ ...(request as object) })).toBeUndefined()
    expect(approveAgentToolRequest(undefined)).toBeUndefined()
    // SAFETY: The cast models a caller that forges the grant shape at runtime.
    const forged = Object.freeze({ requestId: "approval_email_send_forged", toolName: "email_send" }) as unknown as AgentToolApprovalGrant
    await expect(executeApprovedAgentTool(tool, forged)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" })
    await expect(tool.execute!({ recipient: "team@example.com" }, { toolCallId: "call-1" })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("does not let a grant run another tool wrapper with the same name", async () => {
    const first = approvalTool()
    const second = approvalTool()
    const grant = approveAgentToolRequest(await requestApproval(first.tool, { recipient: "team@example.com" }))!

    await expect(executeApprovedAgentTool(second.tool, grant)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(second.execute).not.toHaveBeenCalled()
    await expect(executeApprovedAgentTool(first.tool, grant)).resolves.toEqual({ recipient: "team@example.com" })
  })

  it("does not let a grant run an unwrapped tool with the same name", async () => {
    const { tool } = approvalTool()
    const replacementExecute = vi.fn(async (input: unknown) => input)
    const replacement: AgentToolDefinition = { execute: replacementExecute, name: tool.name }
    const grant = approveAgentToolRequest(await requestApproval(tool, { recipient: "team@example.com" }))!

    await expect(executeApprovedAgentTool(replacement, grant)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(replacementExecute).not.toHaveBeenCalled()
  })

  it("does not let a grant run a copied tool with a replacement executor", async () => {
    const { tool } = approvalTool()
    const replacementExecute = vi.fn(async (input: unknown) => input)
    const replacement = copyToolWithOverrides(tool, { execute: replacementExecute })
    const grant = approveAgentToolRequest(await requestApproval(tool, { recipient: "team@example.com" }))!

    await expect(executeApprovedAgentTool(replacement, grant)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(replacementExecute).not.toHaveBeenCalled()
  })

  it("does not let an unrelated preserving wrapper run an approved tool", async () => {
    const { tool } = approvalTool()
    const unrelatedExecute = vi.fn(async (input: unknown) => input)
    const unrelated = withJsonCompatibleToolOutputs({ email_send: { execute: unrelatedExecute, name: "email_send" } }).email_send!
    const copied = copyToolWithOverrides(tool, { execute: unrelated.execute })
    const grant = approveAgentToolRequest(await requestApproval(tool, { recipient: "team@example.com" }))!

    await expect(executeApprovedAgentTool(copied, grant)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" })
    expect(unrelatedExecute).not.toHaveBeenCalled()
  })
})
