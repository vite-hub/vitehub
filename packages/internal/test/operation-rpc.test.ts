import { describe, expect, it, vi } from "vitest"

import { answerOperationRpc, callOperationRpc, readOperationRpcCall, readOperationRpcReply } from "../src/operation-rpc.ts"

import type { OperationRpcCall, OperationRpcServer } from "../src/operation-rpc.ts"

function server(run = vi.fn((name: string, input: unknown) => ({ name, input }))): OperationRpcServer<string> {
  return {
    failure: (error) => {
      const value = Object(error)
      return { code: String(Reflect.get(value, "code") ?? "FAILED"), message: error instanceof Error ? error.message : "Failed.", status: Number(Reflect.get(value, "status") ?? 500) }
    },
    operations: { "test.echo": "test.echo", "test.fail": "test.fail" },
    run: (name, input) => {
      if (name === "test.fail") throw Object.assign(new Error("The operation failed."), { code: "TEST_FAILED", status: 409 })
      return run(name, input)
    },
    unknown: name => Object.assign(new Error(`No operation is named ${name}.`), { code: "UNKNOWN", status: 404 }),
  }
}

const call = (m: string, a: OperationRpcCall["a"] = []): OperationRpcCall => ({ t: "q", i: "call-1", m, a })

describe("operation RPC over birpc", () => {
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "then", "test.missing"])("refuses %s, which is not an own operation", async (name) => {
    const run = vi.fn()
    const reply = await answerOperationRpc(call(name, [{}]), server(run))
    expect(reply).toEqual({ t: "s", i: "call-1", e: { code: "UNKNOWN", message: `No operation is named ${name}.`, status: 404 } })
    expect(run).not.toHaveBeenCalled()
  })

  it("answers with the value or the diagnostic, and never with the stack", async () => {
    await expect(answerOperationRpc(call("test.echo", [{ text: "hi" }]), server())).resolves.toEqual({ t: "s", i: "call-1", r: { name: "test.echo", input: { text: "hi" } } })
    const failed = await answerOperationRpc(call("test.fail"), server())
    expect(failed).toEqual({ t: "s", i: "call-1", e: { code: "TEST_FAILED", message: "The operation failed.", status: 409 } })
    expect(JSON.stringify(failed)).not.toContain("at ")
  })

  it.each([undefined, null, false, 0, ""])("preserves a falsy rejection reason: %j", async (reason) => {
    for (const run of [() => { throw reason }, () => Promise.reject(reason)]) {
      const adapter = server()
      const failure = vi.spyOn(adapter, "failure")
      const reply = await answerOperationRpc(call("test.echo"), { ...adapter, run })
      expect(reply).toEqual({ t: "s", i: "call-1", e: { code: "FAILED", message: "Failed.", status: 500 } })
      expect(failure).toHaveBeenCalledExactlyOnceWith(reason)
    }
  })

  it.each([
    [{ t: "q", m: "test.echo", a: [] }, "an event without an id"],
    [{ t: "q", i: "1", m: "test.echo", a: [], o: true }, "an optional call"],
    [{ t: "q", i: "1", m: "test.echo", a: [1, 2] }, "two arguments"],
    [{ t: "s", i: "1", m: "test.echo", a: [] }, "a response message"],
    [{ t: "q", i: "1", m: 1, a: [] }, "a method that is not a string"],
    [{ t: "q", i: "x".repeat(129), m: "test.echo", a: [] }, "a long id"],
  ])("does not read %j as a call (%s)", (message) => {
    expect(readOperationRpcCall(message)).toBeUndefined()
  })

  it("reads replies and drops fields that are not diagnostic", () => {
    expect(readOperationRpcReply({ t: "s", i: "1", e: { code: "X", message: "Why.", status: 400, stack: "Error: at x" } })).toEqual({ t: "s", i: "1", e: { code: "X", message: "Why.", status: 400 } })
    expect(readOperationRpcReply({ t: "s", e: { code: "X", message: "Why.", status: 413 } })).toEqual({ t: "s", e: { code: "X", message: "Why.", status: 413 } })
    expect(readOperationRpcReply({ ok: true, value: 1 })).toBeUndefined()
  })

  it("calls through one request and one answer", async () => {
    const sent: unknown[] = []
    const outcome = await callOperationRpc("test.echo", { text: "hi" }, async (body) => {
      const message: unknown = JSON.parse(body)
      sent.push(message)
      return { body: await answerOperationRpc(readOperationRpcCall(message)!, server()), status: 200 }
    })
    expect(outcome).toEqual({ ok: true, value: { name: "test.echo", input: { text: "hi" } }, answer: { body: expect.any(Object), status: 200 } })
    expect(sent).toEqual([{ m: "test.echo", a: [{ text: "hi" }], t: "q", i: expect.any(String) }])
    // birpc writes the method first, so a server can read the name and its byte limit from the first bytes.
    expect(Object.keys(sent[0]!)[0]).toBe("m")
  })

  it("reads a reply without a value as an operation that returned nothing", async () => {
    const outcome = await callOperationRpc("test.echo", {}, async (body) => {
      const reply = await answerOperationRpc(readOperationRpcCall(JSON.parse(body))!, server(vi.fn(() => undefined)))
      return { body: JSON.parse(JSON.stringify(reply)) }
    })
    expect(outcome).toMatchObject({ ok: true, value: undefined })
  })

  it("returns the diagnostic of a failed call", async () => {
    const outcome = await callOperationRpc("test.fail", undefined, async body => ({ body: await answerOperationRpc(readOperationRpcCall(JSON.parse(body))!, server()) }))
    expect(outcome).toMatchObject({ ok: false, error: { code: "TEST_FAILED", message: "The operation failed.", status: 409 } })
  })

  it("takes a refusal without an id as the answer to the call", async () => {
    const outcome = await callOperationRpc("test.echo", {}, async () => ({ body: { t: "s", e: { code: "TOO_LARGE", message: "The body is too large.", status: 413 } } }))
    expect(outcome).toMatchObject({ ok: false, error: { code: "TOO_LARGE", status: 413 } })
  })

  it.each([
    [{ ok: false, code: "CONSOLE_SIGNATURE_MISSING", message: "Sign in.", status: 401 }],
    [{ t: "s", i: "another-call", r: 1 }],
    [undefined],
  ])("reports an answer that is not a reply to the call: %j", async (body) => {
    await expect(callOperationRpc("test.echo", {}, async () => ({ body }))).resolves.toEqual({ ok: false, error: undefined, answer: { body } })
  })

  it("rejects with the failure of the transport", async () => {
    const failure = new TypeError("fetch failed")
    await expect(callOperationRpc("test.echo", {}, async () => { throw failure })).rejects.toBe(failure)
  })
})
