import { fileURLToPath } from "node:url"
import { Diagnostic } from "nostics"
import { beforeAll, expect, it } from "vitest"
import { loadBundledCopy } from "../../runtime/test/fixtures/diagnostic-copy.ts"
import { AgentHttpError, toHttpErrorResponse } from "../src/http-error.ts"
import {
  abortLocalAgentInvocation,
  createAgentInvocationCancellationError,
  isAgentInvocationCancellationError,
  markAgentInvocationCancellationFailure,
  registerAgentInvocationCancellation,
} from "../src/internal/invocation-cancellation.ts"
import type { AgentInvocationStore } from "../src/invocations.ts"

type AgentErrorCopy = typeof import("../src/http-error.ts") & typeof import("../src/internal/invocation-cancellation.ts")
let copy: AgentErrorCopy

beforeAll(async () => {
  const source = ["../src/http-error.ts", "../src/internal/invocation-cancellation.ts"]
    .map(path => `export * from ${JSON.stringify(fileURLToPath(new URL(path, import.meta.url)))}`)
    .join(";\n")
  // SAFETY: The fixture re-exports exactly these two modules from a separate bundle.
  copy = await loadBundledCopy(new URL("../", import.meta.url), source) as AgentErrorCopy
})

it("preserves explicit public HTTP errors across bundles and redacts lookalikes", async () => {
  const foreign = new copy.AgentHttpError(400, "Use a valid request")
  expect(foreign).not.toBeInstanceOf(AgentHttpError)
  const response = toHttpErrorResponse(foreign)!
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: "Use a valid request" })
  expect(await copy.toHttpErrorResponse(new AgentHttpError(409, "Try again"))!.json()).toEqual({ error: "Try again" })

  const lookalikes = [
    Object.assign(new Diagnostic({ code: "AGENT_R0891", why: "private diagnostic" }), { statusCode: 400, name: "AgentHttpError" }),
    { name: "AgentHttpError", code: "AGENT_R0891", message: "private record", statusCode: 400 },
    Object.assign(Object.create(AgentHttpError.prototype), { message: "private prototype", statusCode: 400 }),
    JSON.parse(JSON.stringify(foreign)),
  ]
  for (const error of lookalikes) {
    expect(await toHttpErrorResponse(error, 400)!.json()).toEqual({ code: "INTERNAL", error: "Agent request failed." })
  }
})

it("shares cancellation reasons and owner-observed failures across bundles", () => {
  // SAFETY: This registry only uses the store as an identity key; no store operation runs in this test.
  const owner = {} as AgentInvocationStore
  const controller = new AbortController()
  const unregister = registerAgentInvocationCancellation(owner, "invocation", { ownerId: "owner", abort: reason => controller.abort(reason) })
  try {
    const reason = copy.createAgentInvocationCancellationError("invocation")
    expect(reason).not.toBeInstanceOf(Diagnostic)
    expect(copy.abortLocalAgentInvocation(owner, "invocation", reason).aborted).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(isAgentInvocationCancellationError(controller.signal.reason, "invocation")).toBe(true)
    expect(isAgentInvocationCancellationError(reason, "other")).toBe(false)
    expect(isAgentInvocationCancellationError(new AggregateError([new Error("wrapper", { cause: reason })]), "invocation")).toBe(true)

    const failure = new Error("The driver stopped")
    markAgentInvocationCancellationFailure(failure, reason)
    expect(copy.isAgentInvocationCancellationError(failure, "invocation")).toBe(true)
    const localReason = createAgentInvocationCancellationError("second")
    const secondFailure = new Error("Another driver stopped")
    copy.markAgentInvocationCancellationFailure(secondFailure, localReason)
    expect(isAgentInvocationCancellationError(secondFailure, "second")).toBe(true)
    expect(copy.isAgentInvocationCancellationError(localReason, "second")).toBe(true)
    expect(copy.isAgentInvocationCancellationError(secondFailure, "other")).toBe(false)
  }
  finally {
    unregister()
  }
  expect(abortLocalAgentInvocation(owner, "invocation", undefined).aborted).toBe(false)
})

it("does not treat a diagnostic code or copied fields as cancellation authority", () => {
  const reason = createAgentInvocationCancellationError("invocation")
  const forged = new Diagnostic({ code: "AGENT_R0970", why: "Unrelated configuration error" })
  Object.defineProperty(forged, Symbol.for("vitehub.agentInvocationCancellationId"), { value: "invocation" })
  for (const error of [forged, { ...reason }, JSON.parse(JSON.stringify(reason))]) {
    expect(isAgentInvocationCancellationError(error)).toBe(false)
    expect(copy.isAgentInvocationCancellationError(error, "invocation")).toBe(false)
    const failure = new Error("Unrelated driver failure")
    markAgentInvocationCancellationFailure(failure, error)
    expect(copy.isAgentInvocationCancellationError(failure)).toBe(false)
  }
})
