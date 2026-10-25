import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"

const {
  createMessage, deserializeMessages, Diagnostic, materializeMessageAttachmentData,
  serializeMessages, validateMessage,
} = await import(pathToFileURL(process.argv[2]).href)

const message = overrides => ({ id: "message-1", parts: [], role: "user", ...overrides })
const create = overrides => createMessage({ id: "message-1", role: "user", ...overrides })
const validate = overrides => () => validateMessage(message(overrides))
const part = value => validate({ parts: [value] })
const cases = [
  ["AGENT_R0646", () => materializeMessageAttachmentData([message({ parts: [{ type: "file", mediaType: "text/plain", fetchData: () => undefined }] })]), "[vitehub] file attachment fetchData() did not return supported attachment data."],
  ["AGENT_R0647", validate({ id: "" }), "[vitehub:messages] message.id must be a non-empty string."],
  ["AGENT_R0648", () => create({ metadata: { value: undefined } }), "[vitehub:messages] message.metadata.value must not be undefined."],
  ["AGENT_R0649", () => create({ metadata: { value: () => 1 } }), "[vitehub:messages] message.metadata.value must be JSON serializable."],
  ["AGENT_R0650", () => create({ metadata: { value: Infinity } }), "[vitehub:messages] message.metadata.value must be a finite number."],
  ["AGENT_R0651", () => create({ metadata: { value: new Date("2026-01-01") } }), "[vitehub:messages] message.metadata.value must be serialized before storing."],
  ["AGENT_R0652", () => create({ role: "robot" }), "[vitehub:messages] Unsupported message role: robot."],
  ["AGENT_R0653", validate({ parts: {} }), "[vitehub:messages] message.parts must be an array."],
  ["AGENT_R0654", part({ type: "text" }), "[vitehub:messages] text part requires text."],
  ["AGENT_R0655", part({ type: "approval-decision", id: "a", approved: "yes" }), "[vitehub:messages] approval-decision.approved must be a boolean."],
  ["AGENT_R0656", part({ type: "approval-decision", id: "a", approved: true }), '[vitehub:messages] approval-decision "a" must follow a matching approval-request.'],
  ["AGENT_R0657", part({ type: "tool-result", id: "a", name: "tool", state: "completed" }), '[vitehub:messages] tool-result "a" must follow a matching tool-call or approval-request.'],
  ["AGENT_R0658", part({ type: "data" }), "[vitehub:messages] data part requires data."],
  ["AGENT_R0659", part({ type: "file", data: "x" }), "[vitehub:messages] file part requires a mediaType."],
  ["AGENT_R0660", part({ type: "audio", mediaType: "text/plain", data: "x" }), "[vitehub:messages] audio part requires an audio/* mediaType."],
  ["AGENT_R0661", part({ type: "image", mediaType: "text/plain", data: "x" }), "[vitehub:messages] image part requires an image/* mediaType."],
  ["AGENT_R0662", part({ type: "file", mediaType: "text/plain" }), "[vitehub:messages] file part requires data, fetchData, or url."],
  ["AGENT_R0663", part({ type: "data-title" }), "[vitehub:messages] data part requires data."],
  ["AGENT_R0664", part({ type: "unsupported" }), "[vitehub:messages] Unsupported message part type: unsupported."],
  ["AGENT_R0665", () => serializeMessages([message({ parts: [{ type: "file", mediaType: "text/plain", fetchData: () => "x" }] })]), "[vitehub:messages] serializeMessages() cannot serialize message[0].parts[0].fetchData. Resolve or remove the attachment callback before serializing."],
  ["AGENT_R0666", () => serializeMessages([message({ parts: [{ type: "file", mediaType: "text/plain", data: new Uint8Array([1]) }] })]), "[vitehub:messages] serializeMessages() cannot serialize binary data in message[0].parts[0]. Resolve it to a string or URL before serializing."],
  ["AGENT_R0667", () => deserializeMessages({ version: 2, messages: [] }), "[vitehub:messages] Unsupported serialized messages payload."],
  ["AGENT_R0668", () => deserializeMessages({ version: 1, messages: [null] }), "[vitehub:messages] Serialized messages must contain message records."],
]

for (const [code, run, expectedMessage] of cases) {
  await assert.rejects(async () => run(), error => {
    assert(error instanceof Diagnostic)
    assert(error instanceof Error)
    assert.equal(error.code, code)
    assert.equal(error.name, code)
    assert.equal(error.message, expectedMessage)
    assert.equal(error.why, expectedMessage)
    assert.equal(error.docs, "https://vitehub.dev/docs/reference/errors-diagnostics#agent-public-errors")
    assert.equal(error.fix, undefined)
    return true
  })
}

const valid = create({
  text: "hello",
  parts: [" world", { type: "data-title", data: { title: "Example" } }],
  createdAt: new Date("2026-01-01"),
  metadata: { nested: [null, true, 12, "ok"] },
})
assert.equal(valid.createdAt, "2026-01-01T00:00:00.000Z")
assert.deepEqual(deserializeMessages(serializeMessages([valid])), [valid])
const attachment = create({ parts: [{ type: "file", mediaType: "text/plain", fetchData: async () => "data" }] })
const materialized = await materializeMessageAttachmentData([attachment])
assert.deepEqual(materialized[0].parts, [{ type: "file", mediaType: "text/plain", data: "data" }])
assert.deepEqual(deserializeMessages(serializeMessages(materialized)), materialized)
console.log(`${cases.length} message diagnostics passed`)
