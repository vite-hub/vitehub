import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { applyStreamEvent, createMessage, validateMessage } from "../src/messages.ts"

describe("Agent message date boundaries", () => {
  it.each([false, 0, null])("rejects the invalid falsy timestamp %s at both boundaries", (value) => {
    const timestamp = value as unknown as Date
    expect(() => createMessage({ createdAt: timestamp, role: "user" })).toThrow("must be serialized before storing")
    expect(() => validateMessage({ createdAt: timestamp as unknown as string, id: "message-1", parts: [], role: "user" })).toThrow("must be serialized before storing")
    const message = createMessage({ id: "message-1", role: "assistant", parts: [{ type: "approval-request", id: "approval-1", name: "confirm", input: {} }] })
    expect(() => applyStreamEvent([message], { type: "approval-decision", id: "approval-1", approved: true, decidedAt: timestamp })).toThrow("must be serialized before storing")
  })

  it.each([
    new Date("2026-01-02T03:04:05.000Z"),
    runInNewContext("new Date('2026-01-02T03:04:05.000Z')") as Date,
    "2026-01-02T03:04:05.000Z",
  ])("normalizes valid approval timestamps %s", (decidedAt) => {
    const message = createMessage({ id: "message-1", role: "assistant", parts: [{ type: "approval-request", id: "approval-1", name: "confirm", input: {} }] })
    const updated = applyStreamEvent([message], { type: "approval-decision", id: "approval-1", approved: true, decidedAt })
    expect(updated[0]?.parts[1]).toMatchObject({ decidedAt: "2026-01-02T03:04:05.000Z" })
  })

  it("preserves omitted and empty timestamp behavior", () => {
    expect(createMessage({ role: "user" })).not.toHaveProperty("createdAt")
    expect(createMessage({ createdAt: "", role: "user" })).not.toHaveProperty("createdAt")
  })

  it.each([
    "new Proxy(new Date('2026-01-02T03:04:05.000Z'), { get(target, key, receiver) { if (key === 'toJSON') return undefined; return Reflect.get(target, key, receiver) } })",
    "new Proxy(new Date('2026-01-02T03:04:05.000Z'), { get(target, key, receiver) { if (key === 'toJSON') return undefined; return Reflect.get(target, key, receiver) }, getPrototypeOf() { return Object.prototype } })",
    "new Proxy(new (class Timestamp extends Date {})('2026-01-02T03:04:05.000Z'), { get(target, key, receiver) { if (key === 'toJSON') return undefined; return Reflect.get(target, key, receiver) } })",
  ])("rejects timestamps that hide their JSON hook: %s", (source) => {
    const timestamp = runInNewContext(source) as Date
    expect(JSON.stringify(timestamp)).toBe("{}")
    expect(() => createMessage({ createdAt: timestamp, role: "user" })).toThrow("must be serialized before storing")
    expect(() => validateMessage({ createdAt: timestamp as unknown as string, id: "message-1", parts: [], role: "user" })).toThrow("must be serialized before storing")
  })

  it("rejects an approval timestamp that cannot normalize", () => {
    const timestamp = runInNewContext("new Proxy(new Date(), { get(target, key, receiver) { if (key === 'toJSON') return undefined; return Reflect.get(target, key, receiver) } })") as Date
    const message = createMessage({ id: "message-1", role: "assistant", parts: [{ type: "approval-request", id: "approval-1", name: "confirm", input: {} }] })
    expect(() => applyStreamEvent([message], { type: "approval-decision", id: "approval-1", approved: true, decidedAt: timestamp })).toThrow("must be serialized before storing")
  })

  it("preserves primitive timestamp strings", () => {
    const message = createMessage({ createdAt: "2026-01-02T03:04:05.000Z", role: "user" })
    expect(message.createdAt).toBe("2026-01-02T03:04:05.000Z")
    expect(() => validateMessage(message)).not.toThrow()
  })

  it("rejects a custom object timestamp while preserving it as message data", () => {
    const value = Object.create(null) as Record<string, unknown>
    Object.defineProperty(value, "toJSON", { value: () => "2026-01-02T03:04:05.000Z" })
    expect(() => createMessage({ createdAt: value as unknown as Date, role: "user" })).toThrow("must be serialized before storing")
    const message = createMessage({ metadata: { value }, parts: [{ data: value, type: "data" }], role: "user" })
    expect(JSON.parse(JSON.stringify(message)).metadata).toEqual({ value: "2026-01-02T03:04:05.000Z" })
  })

  it("normalizes a foreign Date subclass", () => {
    const createdAt = runInNewContext("new (class Timestamp extends Date {})('2026-01-02T03:04:05.000Z')") as Date
    expect(createMessage({ createdAt, role: "user" }).createdAt).toBe("2026-01-02T03:04:05.000Z")
  })

  it("rejects foreign Date subclass proxies at both message boundaries", () => {
    const createdAt = runInNewContext("new Proxy(new (class Timestamp extends Date {})(), {})") as Date
    expect(() => createMessage({ createdAt, role: "user" })).toThrow("must be serialized before storing")
    expect(() => validateMessage({ createdAt: createdAt as unknown as string, id: "message-1", parts: [], role: "user" })).toThrow("must be serialized before storing")
    expect(() => createMessage({ metadata: { timestamp: createdAt }, role: "user" })).toThrow("must be serialized before storing")
    expect(() => validateMessage({ id: "message-1", parts: [{ data: { timestamp: createdAt }, type: "data" }], role: "user" })).toThrow("must be serialized before storing")
  })

  it.each([
    "new Proxy(new Date(), { getPrototypeOf() { return Object.prototype } })",
    "new Proxy(new (class Timestamp extends Date {})(), { getPrototypeOf() { return Object.prototype } })",
  ])("rejects unserializable Date proxies hiding their prototype: %s", (source) => {
    const timestamp = runInNewContext(source) as Date
    expect(() => JSON.stringify(timestamp)).toThrow()
    expect(() => createMessage({ createdAt: timestamp, role: "user" })).toThrow("must be serialized before storing")
    expect(() => validateMessage({ createdAt: timestamp as unknown as string, id: "message-1", parts: [], role: "user" })).toThrow("must be serialized before storing")
    expect(() => createMessage({ metadata: { timestamp }, role: "user" })).toThrow("must be serialized before storing")
    expect(() => validateMessage({ id: "message-1", parts: [{ data: { timestamp }, type: "data" }], role: "user" })).toThrow("must be serialized before storing")
  })

  it.each([
    "new (class Date { getTime() { return 0 }; toISOString() { return 'date-like' } })()",
    "Object.create({ constructor: Date, getTime: Date.prototype.getTime, toISOString: Date.prototype.toISOString })",
  ])("accepts ordinary Date-like data: %s", (source) => {
    const value: unknown = runInNewContext(source)
    const message = createMessage({ metadata: { value }, parts: [{ data: value, type: "data" }], role: "user" })
    expect(() => validateMessage(message)).not.toThrow()
    expect(JSON.parse(JSON.stringify(message)).metadata).toEqual({ value: {} })
  })

  it("accepts a serializable custom Date-like JSON hook", () => {
    const value: unknown = runInNewContext("new (class Date { getTime() { return 0 }; toISOString() { return 'date-like' }; toJSON() { return { timestamp: 'date-like' } } })()")
    const message = createMessage({ metadata: { value }, parts: [{ data: value, type: "data" }], role: "user" })
    expect(() => validateMessage(message)).not.toThrow()
    expect(JSON.parse(JSON.stringify(message)).metadata).toEqual({ value: { timestamp: "date-like" } })
  })

  it("normalizes a genuine Date without invoking its custom serialization hook", () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z")
    let calls = 0
    Object.defineProperty(createdAt, "toJSON", { get() { calls++; throw new Error("custom serializer") } })
    expect(createMessage({ createdAt, role: "user" }).createdAt).toBe("2026-01-02T03:04:05.000Z")
    expect(calls).toBe(0)
  })

  it("normalizes a foreign Date when creating a message", () => {
    const createdAt = runInNewContext("new Date('2026-01-02T03:04:05.000Z')") as Date
    const message = createMessage({ createdAt, role: "user", text: "hello" })
    expect(message.createdAt).toBe("2026-01-02T03:04:05.000Z")
  })

  it("rejects a foreign Date in an already assembled message", () => {
    const createdAt = runInNewContext("new Date('2026-01-02T03:04:05.000Z')") as Date
    expect(() => validateMessage({ createdAt: createdAt as unknown as string, id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" })).toThrow()
  })

  it("rejects a Date proxy when creating a message", () => {
    const createdAt = new Proxy(new Date("2026-01-02T03:04:05.000Z"), {})
    expect(() => createMessage({ createdAt, role: "user", text: "hello" })).toThrow()
  })

  it("rejects a Date proxy in an already assembled message", () => {
    const createdAt = new Proxy(new Date("2026-01-02T03:04:05.000Z"), {})
    expect(() => validateMessage({ createdAt: createdAt as unknown as string, id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" })).toThrow()
  })

  it("rejects a cross-realm Date proxy when creating a message", () => {
    const createdAt = runInNewContext("new Proxy(new Date('2026-01-02T03:04:05.000Z'), {})") as Date
    expect(() => createMessage({ createdAt, role: "user", text: "hello" })).toThrow()
  })

  it("rejects a cross-realm Date proxy in an already assembled message", () => {
    const createdAt = runInNewContext("new Proxy(new Date('2026-01-02T03:04:05.000Z'), {})") as Date
    expect(() => validateMessage({ createdAt: createdAt as unknown as string, id: "message-1", parts: [{ text: "hello", type: "text" }], role: "user" })).toThrow()
  })
})
