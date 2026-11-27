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
      signal: AbortSignal.timeout(10_000),
    })
    const state = await pollMarker(run.url, marker, Math.min(run.timeoutMs, 75_000))
    if (state) throw new Error(state.readError || "the probe marker was not visible before the deadline")
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
  if (state.readError) {
    return { stage: "marker-read", detail: `the marker could not be read: ${state.readError}` }
  }
  if (state.error) {
    return { stage: "handler-failed", detail: `the consumer handler threw: ${state.error}` }
  }
  if (state.writeError) {
    return { stage: "marker-write", detail: state.writeError }
  }
  if (state.received) {
    return { stage: "marker-write", detail: "the receipt marker was visible, but the completion marker was not observed" }
  }
  return { stage: "not-received", detail: "no receipt marker was observed; delivery, handler startup, or the receipt callback write may have failed" }
}

async function pollMarker(url, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const markerUrl = new URL(`/api/tests/queue?marker=${encodeURIComponent(marker)}`, url)
  const state = { error: null, readError: null, received: false, writeError: null }

  for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
    try {
      const payload = await requestJson(markerUrl, { signal: AbortSignal.timeout(Math.min(5_000, remaining)) })
      if (!payload?.ok || typeof payload.seen !== "boolean") throw new Error(`Unexpected marker response: ${JSON.stringify(payload)}`)
      if (payload.seen) return
      state.readError = null
      state.received ||= payload.received === true
      if (typeof payload.error === "string") state.error = payload.error
      if (typeof payload.writeError === "string") state.writeError = payload.writeError
    }
    catch (error) {
      state.readError = error instanceof Error ? error.message : String(error)
    }
    const delay = Math.min(1_000, deadline - Date.now())
    if (delay > 0) await sleep(delay)
  }
  return state
}

async function waitForMarker(url, marker, timeoutMs) {
  const state = await pollMarker(url, marker, timeoutMs)
  if (state) throw new Error(JSON.stringify({ marker, seen: false, received: state.received, ...describeStage(state) }))
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
