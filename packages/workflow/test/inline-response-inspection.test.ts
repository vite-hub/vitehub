import { afterEach, assert, expect, it, vi } from "vitest"

import { createWorkflow } from "../src/runtime/client.ts"
import { getWorkflowRunState, resetWorkflowRuntime, setWorkflowRuntimeConfig } from "../src/runtime/state.ts"

afterEach(() => resetWorkflowRuntime())

it.each(["vercel", "cloudflare"] as const)("keeps %s inline output readable across inspections and duplicate starts", async (provider) => {
  setWorkflowRuntimeConfig({ provider })
  const handler = vi.fn(() => new Response(new Uint8Array([0, 128, 255]), {
    status: 201,
    statusText: "Created",
    headers: { "content-type": "application/octet-stream", "x-result": "original" },
  }))
  const workflow = createWorkflow("repeated-inspection", handler)
  await workflow.run(undefined, { id: "run-1" })
  await getWorkflowRunState(workflow.name, "run-1")!.promise

  const first = await workflow.getRun("run-1")
  assert(first.result instanceof Response)
  await expect(first.result.arrayBuffer()).resolves.toEqual(new Uint8Array([0, 128, 255]).buffer)
  first.result.headers.set("x-result", "changed by reader")

  for (const read of [() => workflow.getRun("run-1"), () => workflow.run(undefined, { id: "run-1" })]) {
    const next = await read()
    expect(next.status).toBe("completed")
    assert(next.result instanceof Response)
    expect(next.result.status).toBe(201)
    expect(next.result.statusText).toBe("Created")
    expect(next.result.headers.get("x-result")).toBe("original")
    await expect(next.result.arrayBuffer()).resolves.toEqual(new Uint8Array([0, 128, 255]).buffer)
  }
  expect(handler).toHaveBeenCalledOnce()
})

it("keeps the stored output when an inspector cancels its response", async () => {
  setWorkflowRuntimeConfig({ provider: "vercel" })
  const workflow = createWorkflow("cancelled-inspection", () => new Response("saved output"))
  await workflow.run(undefined, { id: "run-1" })
  await getWorkflowRunState(workflow.name, "run-1")!.promise

  const first = await workflow.getRun("run-1")
  assert(first.result instanceof Response)
  await first.result.body?.cancel()

  const next = await workflow.getRun("run-1")
  assert(next.result instanceof Response)
  await expect(next.result.text()).resolves.toBe("saved output")
})

it("preserves a null response body across inspections", async () => {
  setWorkflowRuntimeConfig({ provider: "vercel" })
  const workflow = createWorkflow("empty-inspection", () => new Response(null, { status: 204 }))
  await workflow.run(undefined, { id: "run-1" })
  await getWorkflowRunState(workflow.name, "run-1")!.promise

  for (let index = 0; index < 2; index++) {
    const run = await workflow.getRun("run-1")
    assert(run.result instanceof Response)
    expect(run.result.status).toBe(204)
    expect(run.result.body).toBeNull()
  }
})

it("records a failed run when its response body cannot be retained", async () => {
  setWorkflowRuntimeConfig({ provider: "vercel" })
  const cause = new Error("output stream failed")
  const workflow = createWorkflow("failed-output", () => new Response(new ReadableStream({
    start(controller) { controller.error(cause) },
  })))
  await workflow.run(undefined, { id: "run-1" })
  await getWorkflowRunState(workflow.name, "run-1")!.promise

  expect(await workflow.getRun("run-1")).toMatchObject({ status: "failed", metadata: cause, result: undefined })
})
