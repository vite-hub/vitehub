import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  store: vi.fn(),
  input: vi.fn(),
  history: vi.fn(),
}))
vi.mock("@vite-hub/agent", () => ({
  startAgentInvocation: mocks.start,
  agentInvocationId: async (id: string) => id,
  createMessage: vi.fn(),
  deserializeMessages: mocks.history,
  isAttachmentPart: () => false,
}))
vi.mock("@vite-hub/runtime", () => ({
  createExecutionContext: (context: unknown) => context,
  createRuntimeWaitUntilController: () => ({ waitUntil: () => {} }),
}))
vi.mock("../src/console/server.ts", () => ({ console: {} }))
vi.mock("../src/console/runtime/server/agents.ts", () => ({
  getConsoleAgentDefinition: () => ({}),
  consoleAgentInvokerProfiles: () => [{ id: "default" }],
}))
vi.mock("../src/console/runtime/server/attachments.ts", () => ({
  consoleAttachmentRequestBytes: 14 * 1024 * 1024,
  withConsoleInputMessage: mocks.store,
  consoleInputMessage: mocks.input,
}))

import handler from "../src/console/runtime/server/agent-invocations.post.ts"

const files = [{ url: "data:image/png;base64,YQ==", filename: "test.png" }]
const invoke = (body: unknown) => handler({ method: "POST", context: { params: { agent: "bot" } }, req: { json: async () => body } })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.store.mockImplementation(async (_prompt, _body, consume) => consume({ role: "user", parts: [{ type: "image", id: "image-id" }] }, () => {}))
  mocks.input.mockResolvedValue({ role: "user", parts: [{ type: "image", id: "image-id" }] })
  mocks.start.mockResolvedValue({ id: "invocation-id", inspect: async () => ({ outcome: "unavailable" }) })
})

it.each([
  { invokerProfileId: "missing" },
  { invokerProfileId: 42 },
  { unexpected: true },
  { messages: "invalid" },
  { attachments: [] },
])("does not store files rejected by invocation validation: %j", async (extra) => {
  await expect(invoke({ prompt: "test", files, ...extra })).rejects.toMatchObject({ statusCode: 400 })
  expect(mocks.store).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it("starts file-only invocations with references from the same request", async () => {
  await expect(invoke({ prompt: "", files, invokerProfileId: "default" })).resolves.toMatchObject({ id: "invocation-id" })
  expect(mocks.store).toHaveBeenCalledWith("", { files }, expect.any(Function))
  expect(mocks.input).not.toHaveBeenCalled()
  expect(mocks.start.mock.calls[0]?.[2]).toMatchObject({ messages: [{ role: "user", parts: [{ type: "image", id: "image-id" }] }] })
})

it("does not start an invocation when the upload fails", async () => {
  const failure = new Error("storage unavailable")
  mocks.store.mockRejectedValue(failure)
  await expect(invoke({ prompt: "test", files })).rejects.toBe(failure)
  expect(mocks.start).not.toHaveBeenCalled()
})

it("still accepts existing stored attachment references without uploading again", async () => {
  const attachments = [{ id: "image-id", name: "test.png" }]
  await invoke({ prompt: "test", attachments })
  expect(mocks.store).not.toHaveBeenCalled()
  expect(mocks.input).toHaveBeenCalledWith("test", attachments)
})

it("accepts image payloads larger than the normal JSON request limit", async () => {
  const largeFiles = [{ url: `data:image/png;base64,${"YQ==".repeat(20000)}` }]
  await expect(invoke({ prompt: "test", files: largeFiles })).resolves.toMatchObject({ id: "invocation-id" })
  expect(mocks.store).toHaveBeenCalledWith("test", { files: largeFiles }, expect.any(Function))
})

it("forwards the rollback boundary to Agent startup", async () => {
  const handoff = vi.fn()
  mocks.store.mockImplementation(async (_prompt, _body, consume) => consume({ role: "user", parts: [] }, handoff))
  await invoke({ prompt: "test", files })
  expect(mocks.start.mock.calls[0]?.[3]).toEqual({ onInputHandoff: handoff })
})
