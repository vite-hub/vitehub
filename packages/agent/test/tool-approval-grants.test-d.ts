import { describe, it } from "vitest"

import { agentChatApprovedTools, withAgentChatApprovalGrant } from "../src/internal/chat-approvals.ts"
import { approveAgentToolRequest, executeApprovedAgentTool } from "../src/tool-runtime.ts"

import type { AgentChatApprovalGrant } from "../src/internal/chat-approvals.ts"
import type { AgentToolApprovalGrant } from "../src/tool-runtime.ts"
import type { AgentToolDefinition } from "../src/types.ts"

declare const tool: AgentToolDefinition
declare const toolGrant: AgentToolApprovalGrant
declare const chatGrant: AgentChatApprovalGrant

describe("approval grant contracts", () => {
  it("accepts only grants from the approval owner", () => {
    const grant = approveAgentToolRequest({ id: "approval-1" })
    if (grant) void executeApprovedAgentTool(tool, grant)
    void executeApprovedAgentTool(tool, toolGrant, { toolCallId: "call-1" })
    withAgentChatApprovalGrant({ invoker: { id: "user-1" } }, chatGrant)

    // @ts-expect-error A tool approval needs a grant, not a request id and tool name.
    void executeApprovedAgentTool(tool, { requestId: "approval-1", toolName: "email_send" })
    // @ts-expect-error A chat session grant cannot run one tool call.
    void executeApprovedAgentTool(tool, chatGrant)
    // @ts-expect-error A list of tool names is not a chat approval grant.
    withAgentChatApprovalGrant({ invoker: { id: "user-1" } }, ["github__createOrUpdateFile"])
    // @ts-expect-error A tool call grant cannot approve tools for a chat session.
    withAgentChatApprovalGrant({ invoker: { id: "user-1" } }, toolGrant)
    // @ts-expect-error Approved tools are read only for a known invoker.
    agentChatApprovedTools({}, "session-1")
  })
})
