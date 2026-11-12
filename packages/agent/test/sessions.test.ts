import { describe, expect, it } from "vitest"

import { agentInvocationId, createMemoryAgentInvocationStore } from "../src/invocations.ts"
import { agentSessionInvocation, importAgentSession, readAgentSession, readClaudeCodeSession, readCodexSession } from "../src/sessions.ts"

const jsonl = (...lines: unknown[]) => `${lines.map(line => JSON.stringify(line)).join("\n")}\n`

// The line shapes Codex 0.5x writes to $CODEX_HOME/sessions/**/rollout-*.jsonl.
const codex = jsonl(
  { timestamp: "2026-11-01T10:00:00.000Z", type: "session_meta", payload: { id: "codex-1", cwd: "/work/app", cli_version: "0.58.0" } },
  { timestamp: "2026-11-01T10:00:00.100Z", type: "turn_context", payload: { model: "gpt-5.5-codex", effort: "high" } },
  { timestamp: "2026-11-01T10:00:00.200Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
  { timestamp: "2026-11-01T10:00:00.300Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a health route." }] } },
  { timestamp: "2026-11-01T10:00:01.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Look at the server folder." }], encrypted_content: "x" } },
  { timestamp: "2026-11-01T10:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-ls", arguments: JSON.stringify({ cmd: "ls server", workdir: "/work/app" }) } },
  { timestamp: "2026-11-01T10:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-ls", output: "Chunk ID: 1\nWall time: 0.25 seconds\nProcess exited with code 0\nOutput:\napi\n" } },
  { timestamp: "2026-11-01T10:00:04.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "call-test", arguments: JSON.stringify({ cmd: "pnpm test" }) } },
  { timestamp: "2026-11-01T10:00:06.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-test", output: JSON.stringify({ output: "1 failed", metadata: { exit_code: 1, duration_seconds: 1.5 } }) } },
  { timestamp: "2026-11-01T10:00:07.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "call-patch", input: "*** Begin Patch\n*** Add File: /work/app/server/routes/health.ts\n+export default () => \"ok\"\n*** Update File: server/api/index.ts\n@@ export\n-old\n+new\n*** End Patch" } },
  { timestamp: "2026-11-01T10:00:08.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-patch", output: "Success." } },
  { timestamp: "2026-11-01T10:00:09.000Z", type: "response_item", payload: { type: "web_search_call", id: "ws-1", status: "completed", action: { type: "search", query: "h3 v2 defineHandler" } } },
  { timestamp: "2026-11-01T10:00:10.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Adding the route." }] } },
  { timestamp: "2026-11-01T10:00:11.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Added /health." }] } },
  { timestamp: "2026-11-01T10:00:11.500Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1200 } } } },
  { timestamp: "2026-11-01T10:00:12.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Added /health." } },
)

// The line shapes Claude Code 2.x writes to $CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl.
const base = { sessionId: "claude-1", cwd: "/work/app", version: "2.1.0" }
const claude = jsonl(
  { ...base, type: "summary", summary: "Health route" },
  { ...base, type: "user", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "Add a health route." } },
  { ...base, type: "user", isMeta: true, timestamp: "2026-11-01T10:00:00.100Z", message: { role: "user", content: "<command-name>/init</command-name>" } },
  { ...base, type: "assistant", timestamp: "2026-11-01T10:00:01.000Z", message: { id: "msg-1", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "Check the routes." }], usage: { input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 90, output_tokens: 40 } } },
  { ...base, type: "assistant", timestamp: "2026-11-01T10:00:01.100Z", message: { id: "msg-1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "tu-bash", name: "Bash", input: { command: "ls server", description: "List server files" } }], usage: { input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 90, output_tokens: 40 } } },
  { ...base, type: "user", timestamp: "2026-11-01T10:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-bash", content: "api" }] }, toolUseResult: { stdout: "api", stderr: "" } },
  { ...base, type: "assistant", isSidechain: true, timestamp: "2026-11-01T10:00:02.500Z", message: { id: "msg-side", content: [{ type: "text", text: "Subagent text." }], usage: { input_tokens: 999, output_tokens: 999 } } },
  { ...base, type: "assistant", timestamp: "2026-11-01T10:00:03.000Z", message: { id: "msg-2", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "tu-write", name: "Write", input: { file_path: "/work/app/server/routes/health.ts", content: "export default () => \"ok\"\n" } }], usage: { input_tokens: 5, output_tokens: 30 } } },
  { ...base, type: "user", timestamp: "2026-11-01T10:00:04.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-write", content: "File created." }] }, toolUseResult: { type: "create", filePath: "/work/app/server/routes/health.ts", content: "export default () => \"ok\"\n", structuredPatch: [] } },
  { ...base, type: "assistant", timestamp: "2026-11-01T10:00:05.000Z", message: { id: "msg-3", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "tu-edit", name: "Edit", input: { file_path: "/work/app/server/api/index.ts", old_string: "old", new_string: "new" } }], usage: { input_tokens: 5, output_tokens: 20 } } },
  { ...base, type: "user", timestamp: "2026-11-01T10:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-edit", content: "Edited." }] }, toolUseResult: { filePath: "/work/app/server/api/index.ts", structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-old", "+new"] }] } },
  { ...base, type: "assistant", timestamp: "2026-11-01T10:00:07.000Z", message: { id: "msg-4", model: "claude-opus-5-5", content: [{ type: "text", text: "Writing it now." }, { type: "text", text: "Added /health." }], usage: { input_tokens: 5, output_tokens: 10 } } },
  "{\"type\":\"assistant\",\"partial", // A file that is still being written can end in a partial line.
)

describe("readCodexSession", () => {
  const session = readCodexSession(codex)

  it("reads the metadata, prompt, answer and usage", () => {
    expect(session).toMatchObject({
      provider: "codex",
      id: "codex-1",
      cwd: "/work/app",
      version: "0.58.0",
      model: "gpt-5.5-codex",
      reasoningEffort: "high",
      status: "completed",
      prompt: "Add a health route.",
      text: "Added /health.",
      startedAt: "2026-11-01T10:00:00.000Z",
      completedAt: "2026-11-01T10:00:12.000Z",
      usage: { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, reasoningTokens: 50, totalTokens: 1200 },
    })
  })

  it("keeps the message phases", () => {
    const messages = session.steps.filter(step => step.type === "message").map(step => [step.phase, step.text])
    expect(messages).toEqual([["reasoning", "Look at the server folder."], ["commentary", "Adding the route."], ["final", "Added /health."]])
  })

  it("reads commands with output, exit code and duration", () => {
    const [ls, test] = session.steps.filter(step => step.type === "tool" && step.name === "command_execution")
    expect(ls).toMatchObject({ input: { command: "ls server", cwd: "/work/app" }, output: { command: "ls server", output: "api\n", exitCode: 0 }, durationMs: 250, completedAt: "2026-11-01T10:00:03.000Z" })
    expect(ls).not.toHaveProperty("error")
    expect(test).toMatchObject({ output: { output: "1 failed", exitCode: 1 }, durationMs: 1500, error: "Exited with code 1." })
  })

  it("reads apply_patch as file changes with paths relative to the working directory", () => {
    const patch = session.steps.find(step => step.type === "tool" && step.name === "apply_patch")
    expect(patch).toMatchObject({
      kind: "change",
      output: {
        output: "Success.",
        item: {
          type: "fileChange",
          changes: [
            { path: "server/routes/health.ts", kind: "add", diff: "@@ -0,0 +1,1 @@\n+export default () => \"ok\"\n" },
            { path: "server/api/index.ts", kind: "update", diff: "@@ -1,1 +1,1 @@ export\n-old\n+new\n" },
          ],
        },
      },
    })
    expect(patch).not.toHaveProperty("changes")
  })

  it("reads web searches", () => {
    expect(session.steps.find(step => step.type === "tool" && step.name === "web_search")).toMatchObject({ title: "Searched the web for h3 v2 defineHandler", output: { status: "completed" } })
  })

  it("marks an aborted turn as failed", () => {
    const aborted = readCodexSession(jsonl({ timestamp: "2026-11-01T10:00:00.000Z", type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }))
    expect(aborted).toMatchObject({ status: "failed", error: "The turn was aborted: interrupted" })
  })
})

describe("readClaudeCodeSession", () => {
  const session = readClaudeCodeSession(claude)

  it("reads the metadata, prompt and answer, and skips meta and sidechain lines", () => {
    expect(session).toMatchObject({ provider: "claude-code", id: "claude-1", cwd: "/work/app", version: "2.1.0", model: "claude-opus-5-5", status: "completed", prompt: "Add a health route.", text: "Added /health." })
    expect(session.steps.some(step => step.type === "message" && step.text === "Subagent text.")).toBe(false)
  })

  it("counts the usage of each message once", () => {
    expect(session.usage).toEqual({ inputTokens: 600 + 5 + 5 + 5, cachedInputTokens: 500, outputTokens: 40 + 30 + 20 + 10, reasoningTokens: 0, totalTokens: 615 + 100 })
  })

  it("makes the last text the answer and keeps thinking as reasoning", () => {
    const messages = session.steps.filter(step => step.type === "message").map(step => [step.phase, step.text])
    expect(messages).toEqual([["reasoning", "Check the routes."], ["commentary", "Writing it now."], ["final", "Added /health."]])
  })

  it("reads Bash as a command and file tools as changes", () => {
    const tools = session.steps.filter(step => step.type === "tool")
    expect(tools[0]).toMatchObject({ name: "Bash", title: "List server files", input: { command: "ls server", cwd: "/work/app" }, output: { command: "ls server", output: "api" } })
    expect(tools[1]).toMatchObject({ name: "Write", kind: "change", title: "Write server/routes/health.ts", output: { item: { changes: [{ path: "server/routes/health.ts", kind: "add", diff: "@@ -0,0 +1,1 @@\n+export default () => \"ok\"\n" }] } } })
    expect(tools[2]).toMatchObject({ name: "Edit", kind: "change", output: { item: { changes: [{ path: "server/api/index.ts", kind: "update", diff: "@@ -3,1 +3,1 @@\n-old\n+new\n" }] } } })
  })
})

describe("readAgentSession", () => {
  it("reads by provider and rejects an unknown one", () => {
    expect(readAgentSession("codex", codex).id).toBe("codex-1")
    expect(readAgentSession("claude-code", claude).id).toBe("claude-1")
    expect(() => readAgentSession("cursor" as never, "")).toThrow(/Unknown session provider/)
  })
})

describe("importAgentSession", () => {
  const options = { agentName: "coder", runId: "eval-1", title: "Health route", annotations: { task: "health" }, cost: { usd: "0.42" }, configuration: { skills: [{ name: "nuxt" }] } }

  it("builds a finished Invocation with the session's own timestamps", async () => {
    const record = await agentSessionInvocation(readCodexSession(codex), options)
    expect(record).toMatchObject({
      id: await agentInvocationId("eval-1", "coder"),
      agentName: "coder",
      status: "completed",
      createdAt: "2026-11-01T10:00:00.000Z",
      completedAt: "2026-11-01T10:00:12.000Z",
      title: "Health route",
      annotations: { task: "health" },
    })
    const names = record.observations.map(observation => observation.name)
    expect(names[0]).toBe("vitehub.agent.configured")
    expect(names.at(-1)).toBe("agent.invocation.finish")
    expect(record.observations.map(observation => observation.sequence)).toEqual(names.map((_, index) => index + 1))
    const configured = record.observations[0]!.attributes!["vitehub.agent.configuration"]
    expect(configured).toMatchObject({ driver: { provider: "codex", model: { id: "gpt-5.5-codex" }, reasoningEffort: "high" }, skills: [{ name: "nuxt" }] })
    const finish = record.observations.at(-1)!.attributes!
    expect(finish).toMatchObject({ "result.text": "Added /health.", "invocation.durationMs": 12_000, "usage.record": { cost: { usd: "0.42", estimated: true, display: "~$0.42" } } })
    const testFinish = record.observations.find(observation => observation.name === "agent.tool.finish" && observation.attributes?.["tool.id"] === "call-test")
    expect(testFinish?.attributes).toMatchObject({ "tool.durationMs": 1500, "tool.error": "Exited with code 1." })
  })

  it("records a failed session as an error", async () => {
    const failed = readCodexSession(jsonl({ timestamp: "2026-11-01T10:00:00.000Z", type: "event_msg", payload: { type: "error", message: "Rate limited." } }))
    const record = await agentSessionInvocation(failed, options)
    expect(record).toMatchObject({ status: "failed", failedAt: "2026-11-01T10:00:00.000Z" })
    expect(record.observations.at(-1)).toMatchObject({ name: "agent.invocation.error", type: "error", attributes: { "error.message": "Rate limited." } })
  })

  it("needs an Agent name and a run id", async () => {
    await expect(agentSessionInvocation(readCodexSession(codex), { agentName: " ", runId: "x" })).rejects.toThrow(/needs agentName and runId/)
  })

  it("writes the record and replaces it on a second import", async () => {
    const store = createMemoryAgentInvocationStore()
    const first = await importAgentSession(store, readCodexSession(codex), options)
    expect(first).toMatchObject({ created: true, replaced: false })
    const second = await importAgentSession(store, readClaudeCodeSession(claude), options)
    expect(second).toEqual({ id: first.id, created: true, replaced: true })
    const stored = await store.get(first.id)
    expect(stored?.observations.find(observation => observation.name === "agent.invocation.start")?.attributes).toMatchObject({ "session.provider": "claude-code" })
  })
})
