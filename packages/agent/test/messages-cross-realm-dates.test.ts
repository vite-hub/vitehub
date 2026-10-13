import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createMessage, validateMessage } from "../src/messages.ts"

describe("Agent message date boundaries", () => {
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
    "new (class Date { getTime() { return 0 }; toISOString() { return 'date-like' } })()",
    "Object.create({ constructor: Date, getTime: Date.prototype.getTime, toISOString: Date.prototype.toISOString })",
  ])("accepts ordinary Date-like data: %s", (source) => {
    const value: unknown = runInNewContext(source)
    const message = createMessage({ metadata: { value }, parts: [{ data: value, type: "data" }], role: "user" })
    expect(() => validateMessage(message)).not.toThrow()
    expect(JSON.parse(JSON.stringify(message)).metadata).toEqual({ value: {} })
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
