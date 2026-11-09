import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { expect, it, vi } from "vitest"

import { installConsoleInvocationFallback } from "../src/console/internal.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import invocationHandler from "../src/console/runtime/server/invocation.get.ts"
import { consoleRequestEvent } from "../src/console/runtime/server/request.ts"

import type { TraceEventLogEntry } from "@vite-hub/runtime"

it.each([2, 3, 31, 32, 33, 63, 64, 65])("serializes the history once for a poll with %s retained observations", async (count) => {
  const store = createMemoryAgentInvocationStore()
  const timestamp = "2026-11-08T00:00:00.000Z"
  const observations: TraceEventLogEntry[] = Array.from({ length: 65 }, (_, index) => ({
    name: "cursor.test.observation",
    sequence: index + 1,
    timestamp,
    type: "lifecycle",
  }))
  await store.create({
    createdAt: timestamp,
    id: "cursor-test",
    observations: observations.slice(0, count),
    status: "running",
    traceId: "cursor-test",
    updatedAt: timestamp,
  })
  installConsoleInvocationFallback(defineAgentInvocations({ store }), "/console-invocation-cursor-test")
  installConsoleAccess({ mode: "open", authorize: () => true })
  const url = "http://localhost/_vitehub/api/invocations/cursor-test"
  const initial = await invocationHandler(consoleRequestEvent(new Request(url)))
  if (initial instanceof Response || !("observationCursor" in initial)) throw new Error("Expected invocation detail")
  for (const observation of observations.slice(count)) await store.update("cursor-test", { observation, timestamp })
  const complete = await invocationHandler(consoleRequestEvent(new Request(url)))
  if (complete instanceof Response || !("observationCursor" in complete)) throw new Error("Expected invocation detail")
  const query = new URLSearchParams({ observationCount: String(count), observationCursor: initial.observationCursor })
  const stringify = vi.spyOn(JSON, "stringify")
  try {
    const result = await invocationHandler(consoleRequestEvent(new Request(`${url}?${query}`)))
    expect(result).toMatchObject({
      appendObservations: true,
      observationCursor: complete.observationCursor,
      observations: observations.slice(count),
    })
    expect(stringify.mock.calls.flatMap(([value]) => {
      const inputs: unknown[] = Array.isArray(value) ? value : [value]
      return inputs.filter(input => input !== null && typeof input === "object" && Reflect.get(input, "name") === "cursor.test.observation")
    })).toHaveLength(observations.length)
  }
  finally {
    stringify.mockRestore()
  }
})
