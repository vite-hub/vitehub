import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

import { requestJson, runE2E } from "@vite-hub/internal/test/e2e-live"

function createBody(marker, callbackUrl) {
  return JSON.stringify({ callbackUrl, email: "ava@example.com", marker })
}

async function checkMarkerStoreWithoutQueue(run) {
  const marker = `${run.directMarker}-store`
  try {
    await requestJson(new URL("/api/tests/queue", run.url), {
      body: JSON.stringify({ marker, stage: "done" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    const payload = await requestJson(new URL(`/api/tests/queue?marker=${encodeURIComponent(marker)}`, run.url))
    if (payload?.seen !== true) {
      throw new Error(`the marker was written but reads back as ${JSON.stringify(payload)}`)
    }
  }
  catch (error) {
    throw new Error(`Queue E2E failed at stage "marker-store": ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function dispatch(run) {
  await checkMarkerStoreWithoutQueue(run)
  const callbackUrl = new URL("/api/tests/queue", run.url).toString()
  const direct = requestJson(new URL("/api/queues/welcome", run.url), {
    body: createBody(run.directMarker, callbackUrl),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => {
    if (!response?.ok || response?.result?.status !== "queued") {
      throw new Error(`Unexpected direct queue response: ${JSON.stringify(response)}`)
    }
  })
  const defer = requestJson(new URL("/api/queues/welcome-defer", run.url), {
    body: createBody(run.deferMarker, callbackUrl),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((response) => {
    if (!response?.ok) {
      throw new Error(`Unexpected deferred queue response: ${JSON.stringify(response)}`)
    }
  })
  await Promise.all([direct, defer])
}

function describeStage(state) {
  if (state.error) {
    return { stage: "handler-failed", detail: `the consumer handler threw: ${state.error}` }
  }
  if (state.received) {
    return { stage: "marker-write", detail: "the consumer handler started, but its final marker write never landed" }
  }
  if (state.readError) {
    return { stage: "marker-read", detail: `the marker could not be read: ${state.readError}` }
  }
  return { stage: "not-received", detail: "the consumer handler never started: the trigger did not fire, or the consumer function failed before the handler" }
}

async function waitForMarker(url, marker, timeoutMs) {
  const startedAt = Date.now()
  let state = { error: null, readError: null, received: false }

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await requestJson(new URL(`/api/tests/queue?marker=${encodeURIComponent(marker)}`, url))
      if (payload?.ok && payload?.seen === true) {
        return
      }
      state = { error: typeof payload?.error === "string" ? payload.error : null, readError: null, received: payload?.received === true }
    }
    catch (error) {
      state = { ...state, readError: error instanceof Error ? error.message : String(error) }
    }
    await sleep(1_000)
  }

  throw new Error(JSON.stringify({ marker, seen: false, received: state.received, ...describeStage(state) }))
}

async function wait(run) {
  const results = await Promise.allSettled([
    waitForMarker(run.url, run.directMarker, run.timeoutMs),
    waitForMarker(run.url, run.deferMarker, run.timeoutMs),
  ])
  const failures = results.filter(r => r.status === "rejected").map(r => r.reason instanceof Error ? r.reason.message : String(r.reason))
  if (failures.length) {
    throw new Error(`Queue markers were not observed: ${failures.join(", ")}`)
  }
}

runE2E({ namespace: "queue", dispatch, wait }).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
